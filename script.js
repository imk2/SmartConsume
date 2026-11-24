/**
 * SmartIOT — Smart Energy Monitoring & Load-Shedding Simulation Engine
 *
 * Pure browser-side JavaScript (no frameworks, external libraries, or live
 * networking hardware). Simulates an ESP32 node reading SCT-013 (AC current)
 * and ZMPT101B (AC line voltage) sensors, evaluating 3-tier threshold zones
 * (Normal / Near Threshold >= 85% / Overload > Threshold), controlling a
 * Virtual Eco-Relay actuator, and recording timestamped telemetry events.
 */
(function () {
  "use strict";

  /* ========================================================================
     1. Specifications & Default Constants
     ======================================================================== */
  const APPLIANCE_SPECS = {
    ac: {
      id: "ac",
      name: "Air Conditioner",
      min: 0,
      max: 2500,
      defaultWatts: 1400,
      defaultOnWatts: 1400,
      ecoCapWatts: 800,
    },
    fridge: {
      id: "fridge",
      name: "Refrigerator",
      min: 0,
      max: 400,
      defaultWatts: 180,
      defaultOnWatts: 180,
    },
    fryer: {
      id: "fryer",
      name: "Air Fryer",
      min: 0,
      max: 1800,
      defaultWatts: 0,
      defaultOnWatts: 1500,
    },
  };

  const DEFAULT_CONFIG = {
    thresholdWatts: 3000,
    voltageRef: 230,
    samplingIntervalSec: 2,
    simulationMode: "manual", // "manual" | "auto"
    autoLoadShedding: false,
    tariffRate: 0.29, // DEWA Green Slab (0.23 + 0.06 fuel surcharge) in AED/kWh
  };

  const TARIFF_MIN = 0.01;
  const TARIFF_MAX = 2.0;
  const DEWA_SLAB_VALUES = ["0.29", "0.34", "0.38", "0.44"];

  const NEAR_THRESHOLD_RATIO = 0.85; // Yellow warning at >= 85% of Overload Threshold
  const GAUGE_SCALE_FACTOR = 1.25;   // Gauge spans 0..125% of threshold (80% arc = limit)
  const MAX_CHART_POINTS = 30;
  const MAX_LOG_ENTRIES = 25;

  /* ========================================================================
     2. Central Application State
     ======================================================================== */
  const state = {
    appliances: {
      ac: {
        enabled: true,
        watts: APPLIANCE_SPECS.ac.defaultWatts,
        lastActiveWatts: APPLIANCE_SPECS.ac.defaultOnWatts,
        ecoMode: false,
        preEcoWatts: APPLIANCE_SPECS.ac.defaultWatts,
      },
      fridge: {
        enabled: true,
        watts: APPLIANCE_SPECS.fridge.defaultWatts,
        lastActiveWatts: APPLIANCE_SPECS.fridge.defaultOnWatts,
      },
      fryer: {
        enabled: false,
        watts: APPLIANCE_SPECS.fryer.defaultWatts,
        lastActiveWatts: APPLIANCE_SPECS.fryer.defaultOnWatts,
      },
    },
    config: { ...DEFAULT_CONFIG },
    tariffSelection: "0.29",
    sessionKwh: 0,
    sessionCostAed: 0,
    history: [],
    packetCount: 0,
    lastZone: null, // Tracks transitions across "normal" | "near" | "overload"
    autoShedNotice: null,
    eventLog: [],
    autoTimerId: null,
  };

  /* ========================================================================
     3. Utility & Input Validation Helpers
     ======================================================================== */
  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Sanitizes numeric inputs against finite bounds [min, max].
   * Supports integer (decimals = 0) and decimal (e.g. tariff decimals = 2) inputs.
   */
  function sanitizeNumericInput(rawValue, min, max, fallback, label, decimals = 0) {
    const trimmed = String(rawValue ?? "").trim();
    const factor = Math.pow(10, decimals);
    const fmt = (n) => (decimals > 0 ? n.toFixed(decimals) : formatNumber(n));

    if (trimmed === "") {
      return {
        value: fallback,
        adjusted: true,
        notice: `${label}: Empty input restored to ${fmt(fallback)}.`,
      };
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return {
        value: fallback,
        adjusted: true,
        notice: `${label}: Non-numeric input "${trimmed}" reset to ${fmt(fallback)}.`,
      };
    }

    if (parsed < min) {
      return {
        value: min,
        adjusted: true,
        notice: `${label}: Input (${parsed}) is below minimum (${fmt(min)}); clamped to ${fmt(min)}.`,
      };
    }

    if (parsed > max) {
      return {
        value: max,
        adjusted: true,
        notice: `${label}: Input (${fmt(parsed)}) exceeds valid range (${fmt(min)}–${fmt(max)}); clamped to ${fmt(max)}.`,
      };
    }

    return {
      value: Math.round(parsed * factor) / factor,
      adjusted: false,
      notice: null,
    };
  }

  let validationTimerId = null;

  function showValidationNotice(message) {
    if (!dom["validation-banner"] || !dom["validation-message"]) return;
    dom["validation-message"].textContent = message;
    dom["validation-banner"].classList.remove("hidden");

    if (validationTimerId !== null) {
      window.clearTimeout(validationTimerId);
    }
    validationTimerId = window.setTimeout(() => {
      hideValidationNotice();
    }, 5000);
  }

  function hideValidationNotice() {
    if (!dom["validation-banner"]) return;
    dom["validation-banner"].classList.add("hidden");
    if (validationTimerId !== null) {
      window.clearTimeout(validationTimerId);
      validationTimerId = null;
    }
  }

  function formatNumber(num) {
    return Math.round(num).toLocaleString("en-US");
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  /**
   * Appends a structured snapshot row to the IoT Telemetry & Action Log table.
   */
  function appendTelemetryLog(metrics, actionTaken, tone) {
    state.eventLog.unshift({
      time: formatTime(new Date()),
      acW: Math.round(metrics.acWatts),
      fridgeW: Math.round(metrics.fridgeWatts),
      fryerW: Math.round(metrics.fryerWatts),
      totalW: Math.round(metrics.totalWatts),
      action: actionTaken,
      tone: tone || "normal", // "normal" | "near" | "alert" | "shed"
    });
    if (state.eventLog.length > MAX_LOG_ENTRIES) {
      state.eventLog.length = MAX_LOG_ENTRIES;
    }
  }

  /* ========================================================================
     4. Telemetry & Decision Rule Engine
     ======================================================================== */
  const TelemetryEngine = {
    /**
     * Computes Total Consumption = AC + Refrigerator + Air Fryer (in W & kW),
     * derived line current (I = P / V), and 3-tier threshold zone.
     */
    computeMetrics() {
      const acWatts = state.appliances.ac.enabled ? state.appliances.ac.watts : 0;
      const fridgeWatts = state.appliances.fridge.enabled ? state.appliances.fridge.watts : 0;
      const fryerWatts = state.appliances.fryer.enabled ? state.appliances.fryer.watts : 0;

      const totalWatts = acWatts + fridgeWatts + fryerWatts;
      const totalKw = totalWatts / 1000;
      const voltage = state.config.voltageRef;
      const totalCurrentA = voltage > 0 ? totalWatts / voltage : 0;
      const threshold = state.config.thresholdWatts;
      const nearThresholdWatts = Math.round(threshold * NEAR_THRESHOLD_RATIO);

      const isOverload = totalWatts > threshold;
      const isNearThreshold = !isOverload && totalWatts >= nearThresholdWatts;
      const healthZone = isOverload ? "overload" : isNearThreshold ? "near" : "normal";
      const loadRatio = threshold > 0 ? (totalWatts / threshold) * 100 : 0;

      const tariffRate = Number.isFinite(state.config.tariffRate)
        ? state.config.tariffRate
        : DEFAULT_CONFIG.tariffRate;
      const hourlyCostAed = totalKw * tariffRate;
      const monthlyCostAed = totalKw * 24 * 30 * tariffRate;

      return {
        acWatts,
        fridgeWatts,
        fryerWatts,
        totalWatts,
        totalKw,
        voltage,
        totalCurrentA,
        threshold,
        nearThresholdWatts,
        isOverload,
        isNearThreshold,
        healthZone,
        loadRatio,
        tariffRate,
        hourlyCostAed,
        monthlyCostAed,
      };
    },

    /**
     * Switches the Air Fryer OFF while preserving its previous active wattage.
     */
    shedAirFryer(sourceLabel) {
      const fryer = state.appliances.fryer;
      if (!fryer.enabled && fryer.watts === 0) {
        return false;
      }
      if (fryer.watts > 0) {
        fryer.lastActiveWatts = fryer.watts;
      }
      const previousWatts = fryer.watts;
      fryer.enabled = false;
      fryer.watts = 0;

      const updated = this.computeMetrics();
      appendTelemetryLog(
        updated,
        `Eco-Relay (${sourceLabel}): Air Fryer switched OFF (-${formatNumber(previousWatts)} W)`,
        "shed"
      );
      return true;
    },

    /**
     * Enables Eco Mode on the Air Conditioner, capping draw at 800 W.
     */
    enableAcEcoMode(sourceLabel) {
      const ac = state.appliances.ac;
      const cap = APPLIANCE_SPECS.ac.ecoCapWatts;

      if (!ac.enabled || (ac.ecoMode && ac.watts <= cap)) {
        return false;
      }

      const previousWatts = ac.watts;
      if (!ac.ecoMode) {
        ac.preEcoWatts = ac.watts;
        ac.ecoMode = true;
      }

      if (ac.watts > cap) {
        ac.watts = cap;
        ac.lastActiveWatts = cap;
      }

      const delta = previousWatts - ac.watts;
      const updated = this.computeMetrics();
      appendTelemetryLog(
        updated,
        `Eco-Relay (${sourceLabel}): AC set to Eco Mode <= ${cap} W` +
          (delta > 0 ? ` (-${formatNumber(delta)} W)` : ""),
        "shed"
      );
      return true;
    },

    /**
     * Evaluates threshold crossings and executes Automatic Load-Shedding when enabled.
     */
    evaluateControlRules() {
      let metrics = this.computeMetrics();
      const prevZone = state.lastZone;

      // Record threshold zone crossings in the Telemetry & Action Log
      if (prevZone !== null && metrics.healthZone !== prevZone) {
        if (metrics.healthZone === "overload") {
          appendTelemetryLog(
            metrics,
            `Threshold Exceeded (> ${formatNumber(metrics.threshold)} W) — OVERLOAD ALERT ON`,
            "alert"
          );
        } else if (metrics.healthZone === "near") {
          appendTelemetryLog(
            metrics,
            prevZone === "overload"
              ? `Dropped <= ${formatNumber(metrics.threshold)} W (Near Threshold >= 85%)`
              : `Crossed >= 85% Near Threshold (${formatNumber(metrics.nearThresholdWatts)} W)`,
            "near"
          );
        } else if (metrics.healthZone === "normal") {
          appendTelemetryLog(
            metrics,
            `Returned to Normal (< 85% of ${formatNumber(metrics.threshold)} W limit)`,
            "normal"
          );
        }
      }

      // Automatic Load-Shedding cascade when Total > Threshold
      if (metrics.isOverload && state.config.autoLoadShedding) {
        const peakWatts = metrics.totalWatts;
        const actionsTaken = [];

        if (this.shedAirFryer("Auto-Relay")) {
          actionsTaken.push("Air Fryer switched OFF");
        }

        metrics = this.computeMetrics();
        if (metrics.isOverload && state.appliances.ac.enabled && !state.appliances.ac.ecoMode) {
          if (this.enableAcEcoMode("Auto-Relay")) {
            actionsTaken.push(`AC set to Eco Mode (<= ${APPLIANCE_SPECS.ac.ecoCapWatts} W)`);
          }
          metrics = this.computeMetrics();
        }

        if (actionsTaken.length > 0) {
          state.autoShedNotice = {
            peakWatts,
            resultingWatts: metrics.totalWatts,
            threshold: metrics.threshold,
            actions: actionsTaken.join(" + "),
            resolved: !metrics.isOverload,
          };
        }
      }

      state.lastZone = metrics.healthZone;
      return metrics;
    },

    /**
     * Builds the simulated Wi-Fi / MQTT JSON telemetry packet (CLO4).
     */
    buildMqttPacket(metrics) {
      const relayState = metrics.isOverload
        ? "ACTIVE_LOAD_SHEDDING"
        : state.autoShedNotice
          ? "AUTO_SHED_TRIPPED"
          : "STANDBY";

      return {
        device_id: "esp32-smartiot-01",
        timestamp: new Date().toISOString(),
        sensors_modeled: ["SCT-013 (Current)", "ZMPT101B (Voltage)"],
        telemetry_mode: "LOCAL_BROWSER_SIMULATION",
        sampling_interval_s: state.config.samplingIntervalSec,
        simulation_mode: state.config.simulationMode,
        line_voltage_v: metrics.voltage,
        line_current_a: Number(metrics.totalCurrentA.toFixed(2)),
        total_power_w: Math.round(metrics.totalWatts),
        total_power_kw: Number(metrics.totalKw.toFixed(3)),
        tariff_aed_per_kwh: Number(metrics.tariffRate.toFixed(2)),
        live_cost_aed_per_hr: Number(metrics.hourlyCostAed.toFixed(2)),
        projected_monthly_cost_aed: Number(metrics.monthlyCostAed.toFixed(2)),
        session_energy_kwh: Number(state.sessionKwh.toFixed(4)),
        session_cost_aed: Number(state.sessionCostAed.toFixed(4)),
        overload_threshold_w: metrics.threshold,
        threshold_zone: metrics.healthZone.toUpperCase(),
        status: metrics.isOverload ? "OVERLOAD ALERT" : "NORMAL",
        overload_alert: metrics.isOverload,
        virtual_eco_relay: relayState,
        appliances_w: {
          air_conditioner: Math.round(metrics.acWatts),
          air_conditioner_eco_mode: state.appliances.ac.ecoMode,
          refrigerator: Math.round(metrics.fridgeWatts),
          air_fryer: Math.round(metrics.fryerWatts),
        },
      };
    },
  };

  /* ========================================================================
     5. Live Auto-Simulation Fluctuation Generator
     ======================================================================== */
  const SensorSimulator = {
    stepSimulation() {
      const ac = state.appliances.ac;
      if (ac.enabled) {
        const acMax = ac.ecoMode ? APPLIANCE_SPECS.ac.ecoCapWatts : APPLIANCE_SPECS.ac.max;
        const delta = Math.round((Math.random() - 0.48) * 130);
        const baseline = ac.watts > 0 ? ac.watts : 900;
        ac.watts = clamp(baseline + delta, 220, acMax);
        ac.lastActiveWatts = ac.watts;
      }

      const fridge = state.appliances.fridge;
      if (fridge.enabled) {
        const roll = Math.random();
        if (roll < 0.08) {
          fridge.watts = Math.round(25 + Math.random() * 25);
        } else if (roll > 0.94) {
          fridge.watts = Math.round(260 + Math.random() * 90);
        } else {
          const anchor = fridge.watts < 60 ? 175 : fridge.watts;
          const delta = Math.round((Math.random() - 0.5) * 36);
          fridge.watts = clamp(anchor + delta, 120, 260);
        }
        fridge.lastActiveWatts = fridge.watts;
      }

      const fryer = state.appliances.fryer;
      if (fryer.enabled) {
        const roll = Math.random();
        if (roll < 0.14) {
          fryer.watts = Math.round(180 + Math.random() * 140);
        } else {
          const anchor = fryer.watts < 400 ? 1480 : fryer.watts;
          const delta = Math.round((Math.random() - 0.48) * 180);
          fryer.watts = clamp(anchor + delta, 1150, APPLIANCE_SPECS.fryer.max);
        }
        fryer.lastActiveWatts = fryer.watts;
      }
    },

    startAutoLoop() {
      this.stopAutoLoop();
      const intervalMs = state.config.samplingIntervalSec * 1000;
      state.autoTimerId = window.setInterval(() => {
        this.stepSimulation();
        updateAll(true, null, true);
      }, intervalMs);
    },

    stopAutoLoop() {
      if (state.autoTimerId !== null) {
        window.clearInterval(state.autoTimerId);
        state.autoTimerId = null;
      }
    },
  };

  /* ========================================================================
     6. SVG Semicircular Power Gauge & Canvas Telemetry Chart Renderers
     ======================================================================== */
  const GaugeRenderer = {
    cx: 130,
    cy: 128,
    radius: 98,

    pointOnArc(fraction, radiusOverride) {
      const r = radiusOverride || this.radius;
      const angle = Math.PI * clamp(fraction, 0, 1);
      return {
        x: this.cx - r * Math.cos(angle),
        y: this.cy - r * Math.sin(angle),
      };
    },

    buildSubArc(startFrac, endFrac) {
      const p1 = this.pointOnArc(startFrac);
      const p2 = this.pointOnArc(endFrac);
      return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${this.radius} ${this.radius} 0 0 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    },

    initStaticTracks() {
      const limitFrac = 1 / GAUGE_SCALE_FACTOR; // 0.80
      const nearFrac = NEAR_THRESHOLD_RATIO * limitFrac; // 0.68

      dom["gauge-zone-normal"].setAttribute("d", this.buildSubArc(0, nearFrac));
      dom["gauge-zone-near"].setAttribute("d", this.buildSubArc(nearFrac, limitFrac));
      dom["gauge-zone-overload"].setAttribute("d", this.buildSubArc(limitFrac, 1));

      const tickInner = this.pointOnArc(limitFrac, this.radius - 11);
      const tickOuter = this.pointOnArc(limitFrac, this.radius + 11);
      dom["gauge-threshold-tick"].setAttribute("x1", tickInner.x.toFixed(2));
      dom["gauge-threshold-tick"].setAttribute("y1", tickInner.y.toFixed(2));
      dom["gauge-threshold-tick"].setAttribute("x2", tickOuter.x.toFixed(2));
      dom["gauge-threshold-tick"].setAttribute("y2", tickOuter.y.toFixed(2));
    },

    update(metrics) {
      const gaugeMax = Math.max(1, metrics.threshold * GAUGE_SCALE_FACTOR);
      const fillFrac = clamp(metrics.totalWatts / gaugeMax, 0, 1);
      const totalLen = Math.PI * this.radius;

      const activeArc = dom["gauge-active-arc"];
      activeArc.style.strokeDasharray = `${totalLen.toFixed(2)}`;
      activeArc.style.strokeDashoffset = `${(totalLen * (1 - fillFrac)).toFixed(2)}`;

      dom["gauge-max-label"].textContent = `${formatNumber(gaugeMax)} W`;
      dom["tick-near-label"].textContent = `85% (${formatNumber(metrics.nearThresholdWatts)} W)`;
      dom["tick-limit-label"].textContent = `Limit (${formatNumber(metrics.threshold)} W)`;

      const headroomDiff = metrics.threshold - metrics.totalWatts;
      dom["gauge-headroom"].textContent =
        headroomDiff >= 0
          ? `${formatNumber(headroomDiff)} W headroom`
          : `+${formatNumber(Math.abs(headroomDiff))} W over limit`;

      const barFillPct = clamp((metrics.totalWatts / gaugeMax) * 100, 0, 100);
      const loadFill = dom["kpi-load-fill"];
      loadFill.style.width = `${barFillPct.toFixed(1)}%`;
      loadFill.className = `threshold-fill zone-${metrics.healthZone}`;
    },
  };

  const ChartRenderer = {
    draw(canvas, history, thresholdWatts, nearWatts) {
      if (!canvas) return;
      const rect = canvas.parentElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const dpr = window.devicePixelRatio || 1;
      const width = rect.width;
      const height = rect.height;

      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }

      const ctx = canvas.getContext("2d");
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const pad = { top: 18, right: 16, bottom: 26, left: 54 };
      const plotW = Math.max(10, width - pad.left - pad.right);
      const plotH = Math.max(10, height - pad.top - pad.bottom);

      const maxPoint = history.reduce((acc, pt) => Math.max(acc, pt.totalWatts), 0);
      const yMax = Math.max(4000, Math.ceil((Math.max(maxPoint, thresholdWatts) * 1.15) / 500) * 500);
      const yToPx = (w) => pad.top + plotH - (w / yMax) * plotH;

      // Grid lines & Y-axis labels
      ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
      ctx.fillStyle = "#64748b";
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";

      const gridSteps = 4;
      for (let i = 0; i <= gridSteps; i++) {
        const val = (yMax / gridSteps) * i;
        const y = yToPx(val);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
        ctx.fillText(`${Math.round(val)} W`, pad.left - 8, y);
      }

      // 85% Near Threshold dashed line (Yellow)
      const nearY = yToPx(nearWatts);
      ctx.save();
      ctx.strokeStyle = "rgba(245, 158, 11, 0.65)";
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, nearY);
      ctx.lineTo(pad.left + plotW, nearY);
      ctx.stroke();
      ctx.restore();

      // 100% Overload Threshold dashed line (Red)
      const threshY = yToPx(thresholdWatts);
      ctx.save();
      ctx.strokeStyle = "rgba(239, 68, 68, 0.85)";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(pad.left, threshY);
      ctx.lineTo(pad.left + plotW, threshY);
      ctx.stroke();
      ctx.restore();

      // Plot power series
      if (history.length > 0) {
        const count = history.length;
        const stepX = count > 1 ? plotW / (MAX_CHART_POINTS - 1) : 0;
        const startX = pad.left + (MAX_CHART_POINTS - count) * stepX;

        const points = history.map((pt, idx) => ({
          x: count === 1 ? pad.left + plotW : startX + idx * stepX,
          y: yToPx(pt.totalWatts),
          watts: pt.totalWatts,
          label: pt.label,
        }));

        const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
        gradient.addColorStop(0, "rgba(56, 189, 248, 0.28)");
        gradient.addColorStop(1, "rgba(56, 189, 248, 0.01)");

        ctx.beginPath();
        ctx.moveTo(points[0].x, pad.top + plotH);
        points.forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.lineTo(points[points.length - 1].x, pad.top + plotH);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        points.forEach((p, idx) => {
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2.2;
        ctx.stroke();

        // Color-coded sample dots matching Normal / Near / Overload
        points.forEach((p, idx) => {
          let color = "#38bdf8";
          if (p.watts > thresholdWatts) color = "#ef4444";
          else if (p.watts >= nearWatts) color = "#f59e0b";

          ctx.beginPath();
          ctx.arc(p.x, p.y, idx === points.length - 1 ? 4.2 : 2.7, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        });

        ctx.fillStyle = "#64748b";
        ctx.textBaseline = "top";
        if (points.length > 1) {
          ctx.textAlign = "left";
          ctx.fillText(points[0].label, pad.left, pad.top + plotH + 7);
        }
        ctx.textAlign = "right";
        ctx.fillText(points[points.length - 1].label, pad.left + plotW, pad.top + plotH + 7);
      }

      ctx.restore();
    },
  };

  /* ========================================================================
     7. DOM Cache & UI Rendering
     ======================================================================== */
  const dom = {};

  function cacheDom() {
    const ids = [
      "sim-mode-pill",
      "sim-mode-pill-text",
      "btn-preset-overload",
      "btn-reset-defaults",
      "validation-banner",
      "validation-message",
      "btn-dismiss-validation",
      "gauge-card",
      "gauge-zone-badge",
      "gauge-zone-normal",
      "gauge-zone-near",
      "gauge-zone-overload",
      "gauge-active-arc",
      "gauge-threshold-tick",
      "gauge-max-label",
      "tick-near-label",
      "tick-limit-label",
      "gauge-headroom",
      "kpi-total-watts",
      "kpi-total-kw",
      "kpi-total-amps",
      "kpi-load-percent",
      "kpi-load-fill",
      "kpi-threshold-label",
      "kpi-status-card",
      "kpi-status-pill",
      "kpi-system-status",
      "kpi-status-detail",
      "kpi-alert-card",
      "kpi-alert-state",
      "kpi-alert-detail",
      "kpi-relay-card",
      "kpi-relay-state",
      "kpi-relay-detail",
      "kpi-cost-card",
      "kpi-cost-rate-badge",
      "kpi-cost-hourly",
      "kpi-cost-monthly",
      "kpi-session-energy",
      "kpi-session-cost",
      "relay-panel",
      "relay-badge",
      "relay-message",
      "auto-shed-toggle",
      "btn-shed-fryer",
      "btn-shed-ac-eco",
      "btn-dismiss-shed-notice",
      "relay-log-count",
      "telemetry-log-body",
      "btn-clear-log",
      "toggle-ac-eco",
      "badge-ac-eco",
      "power-chart",
      "chart-legend-near",
      "chart-legend-threshold",
      "chart-sample-count",
      "next-sample-indicator",
      "config-voltage",
      "config-threshold",
      "config-tariff",
      "config-tariff-slab",
      "mqtt-packet-counter",
      "mqtt-payload",
      "btn-copy-mqtt",
    ];
    ids.forEach((id) => {
      dom[id] = document.getElementById(id);
    });

    dom.appliances = {};
    Object.keys(APPLIANCE_SPECS).forEach((id) => {
      dom.appliances[id] = {
        card: document.getElementById(`card-${id}`),
        statusBadge: document.getElementById(`status-badge-${id}`),
        toggle: document.getElementById(`toggle-${id}`),
        badge: document.getElementById(`badge-${id}`),
        watts: document.getElementById(`watts-${id}`),
        meta: document.getElementById(`meta-${id}`),
        shareBadge: document.getElementById(`share-badge-${id}`),
        sharePctText: document.getElementById(`share-pct-text-${id}`),
        slider: document.getElementById(`slider-${id}`),
        input: document.getElementById(`input-${id}`),
        bar: document.getElementById(`bar-${id}`),
      };
    });

    dom.simModeRadios = Array.from(document.querySelectorAll('input[name="sim-mode"]'));
    dom.intervalRadios = Array.from(document.querySelectorAll('input[name="sampling-interval"]'));
  }

  function getZoneBadgeConfig(zone) {
    if (zone === "overload") {
      return { className: "status-badge badge-overload", text: "Overload (> Limit)" };
    }
    if (zone === "near") {
      return { className: "status-badge badge-near", text: "Near Threshold (>= 85%)" };
    }
    return { className: "status-badge badge-normal", text: "Normal (< 85%)" };
  }

  function renderTelemetryTable() {
    const tbody = dom["telemetry-log-body"];
    const count = state.eventLog.length;
    dom["relay-log-count"].textContent = `${count} event${count === 1 ? "" : "s"}`;
    tbody.innerHTML = "";

    if (count === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "table-empty-cell";
      td.textContent = "No telemetry events recorded. Adjust loads past 85% / threshold or trigger Eco-Relay.";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    state.eventLog.forEach((entry) => {
      const tr = document.createElement("tr");
      tr.className = `row-${entry.tone}`;

      const cells = [
        entry.time,
        `${formatNumber(entry.acW)} W`,
        `${formatNumber(entry.fridgeW)} W`,
        `${formatNumber(entry.fryerW)} W`,
        `${formatNumber(entry.totalW)} W`,
        entry.action,
      ];

      cells.forEach((val, idx) => {
        const td = document.createElement("td");
        if (idx === 4) {
          td.className = "total-strong";
        }
        td.textContent = val;
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  }

  function renderDashboard(metrics, skipInputOverwriteForId) {
    // 1. Header Simulation Pill
    const isAuto = state.config.simulationMode === "auto";
    dom["sim-mode-pill"].classList.toggle("mode-auto", isAuto);
    dom["sim-mode-pill"].classList.toggle("mode-manual", !isAuto);
    dom["sim-mode-pill-text"].textContent = isAuto
      ? `AUTO-SIM · ${state.config.samplingIntervalSec}s`
      : "MANUAL MODE";

    // 2. Live Power Gauge & Threshold Bar
    dom["kpi-total-watts"].textContent = `${formatNumber(metrics.totalWatts)} W`;
    dom["kpi-total-kw"].textContent = `${metrics.totalKw.toFixed(2)} kW`;
    dom["kpi-total-amps"].textContent = `${metrics.totalCurrentA.toFixed(2)} A @ ${metrics.voltage} V`;
    dom["kpi-load-percent"].textContent = `${metrics.loadRatio.toFixed(1)}% of limit`;
    dom["kpi-threshold-label"].textContent = `Limit: ${formatNumber(metrics.threshold)} W`;

    dom["gauge-card"].classList.remove("zone-normal", "zone-near", "zone-overload");
    dom["gauge-card"].classList.add(`zone-${metrics.healthZone}`);

    const zoneBadge = getZoneBadgeConfig(metrics.healthZone);
    dom["gauge-zone-badge"].className = zoneBadge.className;
    dom["gauge-zone-badge"].textContent = zoneBadge.text;

    GaugeRenderer.update(metrics);

    // 3. System Status, Overload Alert & Virtual Eco-Relay KPI Cards
    const statusCard = dom["kpi-status-card"];
    statusCard.classList.remove("status-normal", "status-near", "status-overload");
    statusCard.classList.add(`status-${metrics.healthZone}`);
    dom["kpi-status-pill"].className = zoneBadge.className;
    dom["kpi-status-pill"].textContent =
      metrics.healthZone === "overload"
        ? "Overload"
        : metrics.healthZone === "near"
          ? "Near Threshold"
          : "Normal";

    dom["kpi-system-status"].textContent = metrics.isOverload ? "OVERLOAD ALERT" : "NORMAL";
    dom["kpi-status-detail"].textContent = metrics.isOverload
      ? `${formatNumber(metrics.totalWatts)} W > ${formatNumber(metrics.threshold)} W threshold`
      : metrics.isNearThreshold
        ? `At ${metrics.loadRatio.toFixed(1)}% of limit (>= 85% warning)`
        : `${formatNumber(metrics.totalWatts)} W <= ${formatNumber(metrics.threshold)} W threshold`;

    dom["kpi-alert-card"].classList.toggle("alert-on", metrics.isOverload);
    dom["kpi-alert-card"].classList.toggle("alert-off", !metrics.isOverload);
    dom["kpi-alert-state"].textContent = metrics.isOverload ? "ON" : "OFF";
    dom["kpi-alert-detail"].textContent = metrics.isOverload
      ? `Exceeds limit by ${formatNumber(metrics.totalWatts - metrics.threshold)} W`
      : metrics.isNearThreshold
        ? "Approaching overload threshold"
        : "Load within safe operating limit";

    const relayCard = dom["kpi-relay-card"];
    const relayPanel = dom["relay-panel"];
    relayCard.classList.remove("relay-standby", "relay-active");
    relayPanel.classList.remove("state-standby", "state-near", "state-overload", "state-autoshed");

    if (metrics.isOverload) {
      relayCard.classList.add("relay-active");
      relayPanel.classList.add("state-overload");
      dom["kpi-relay-state"].textContent = "ACTIVE";
      dom["kpi-relay-detail"].textContent = "Load-shedding action triggered";
      dom["relay-badge"].className = "status-pill pill-overload";
      dom["relay-badge"].textContent = "ECO-RELAY: LOAD SHEDDING ACTIVE";
      dom["relay-message"].textContent =
        `OVERLOAD ALERT: Total demand (${formatNumber(metrics.totalWatts)} W) exceeds the ` +
        `${formatNumber(metrics.threshold)} W threshold by ${formatNumber(metrics.totalWatts - metrics.threshold)} W. ` +
        `Use a load-shedding action below or enable Auto Load-Shedding.`;
    } else if (state.autoShedNotice) {
      relayCard.classList.add("relay-active");
      relayPanel.classList.add("state-autoshed");
      dom["kpi-relay-state"].textContent = "AUTO-SHED";
      dom["kpi-relay-detail"].textContent = "Load stabilized below threshold";
      dom["relay-badge"].className = "status-pill pill-autoshed";
      dom["relay-badge"].textContent = "ECO-RELAY: AUTO-SHED EXECUTED";
      dom["relay-message"].textContent =
        `Automatic load-shedding activated at ${formatNumber(state.autoShedNotice.peakWatts)} W: ` +
        `${state.autoShedNotice.actions}. Load dropped to ${formatNumber(state.autoShedNotice.resultingWatts)} W (NORMAL).`;
    } else {
      relayCard.classList.add("relay-standby");
      relayPanel.classList.add(metrics.isNearThreshold ? "state-near" : "state-standby");
      dom["kpi-relay-state"].textContent = "STANDBY";
      dom["kpi-relay-detail"].textContent = metrics.isNearThreshold
        ? "Monitoring >= 85% load"
        : "No load-shedding required";
      dom["relay-badge"].className = "status-pill pill-standby";
      dom["relay-badge"].textContent = "ECO-RELAY: STANDBY";
      dom["relay-message"].textContent = metrics.isNearThreshold
        ? `Total consumption (${formatNumber(metrics.totalWatts)} W) is at ${metrics.loadRatio.toFixed(1)}% of the ${formatNumber(
            metrics.threshold
          )} W limit. Virtual Eco-Relay remains on STANDBY.`
        : `Total consumption (${formatNumber(metrics.totalWatts)} W) is within the ` +
          `${formatNumber(metrics.threshold)} W threshold. Virtual Eco-Relay remains on STANDBY.`;
    }

    dom["btn-dismiss-shed-notice"].classList.toggle("hidden", !state.autoShedNotice || metrics.isOverload);
    dom["auto-shed-toggle"].checked = state.config.autoLoadShedding;
    dom["btn-shed-fryer"].disabled = !state.appliances.fryer.enabled || metrics.fryerWatts === 0;
    dom["btn-shed-ac-eco"].disabled =
      !state.appliances.ac.enabled || (state.appliances.ac.ecoMode && metrics.acWatts <= APPLIANCE_SPECS.ac.ecoCapWatts);

    // 3b. Estimated Energy Cost Card (AED/kWh, AED/hr, Monthly AED, Session kWh & AED)
    dom["kpi-cost-rate-badge"].textContent = `${metrics.tariffRate.toFixed(2)} AED/kWh`;
    dom["kpi-cost-hourly"].textContent = `${metrics.hourlyCostAed.toFixed(2)} AED/hr`;
    dom["kpi-cost-monthly"].textContent = `${metrics.monthlyCostAed.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} AED/mo`;
    dom["kpi-session-energy"].textContent = `${state.sessionKwh.toFixed(4)} kWh`;
    dom["kpi-session-cost"].textContent = `${state.sessionCostAed.toFixed(4)} AED`;

    // 4. Appliance Cards (Watts, % of Total Load, Hourly Cost, Color-Coded Status Badges)
    Object.keys(APPLIANCE_SPECS).forEach((id) => {
      const app = state.appliances[id];
      const els = dom.appliances[id];
      const activeWatts = app.enabled ? app.watts : 0;
      const appKw = activeWatts / 1000;
      const appAmps = metrics.voltage > 0 ? activeWatts / metrics.voltage : 0;
      const appHourlyCost = appKw * metrics.tariffRate;
      const sharePct = metrics.totalWatts > 0 ? (activeWatts / metrics.totalWatts) * 100 : 0;

      els.card.classList.remove("is-on", "is-off", "zone-normal", "zone-near", "zone-overload", "zone-off");
      els.card.classList.add(app.enabled ? "is-on" : "is-off");
      els.card.classList.add(app.enabled ? `zone-${metrics.healthZone}` : "zone-off");

      if (!app.enabled) {
        els.statusBadge.className = "status-badge badge-off";
        els.statusBadge.textContent = "OFF";
      } else if (metrics.healthZone === "overload") {
        els.statusBadge.className = "status-badge badge-overload";
        els.statusBadge.textContent = "Overload";
      } else if (metrics.healthZone === "near") {
        els.statusBadge.className = "status-badge badge-near";
        els.statusBadge.textContent = "Near Threshold";
      } else {
        els.statusBadge.className = "status-badge badge-normal";
        els.statusBadge.textContent = "Normal";
      }

      els.toggle.checked = app.enabled;
      els.badge.textContent = app.enabled ? "ON" : "OFF";
      els.watts.textContent = `${formatNumber(activeWatts)} W`;
      els.meta.textContent = `${appKw.toFixed(2)} kW · ${appAmps.toFixed(2)} A · ${appHourlyCost.toFixed(2)} AED/hr`;
      els.shareBadge.textContent = `${sharePct.toFixed(1)}% of total`;
      els.sharePctText.textContent = `${sharePct.toFixed(1)}%`;
      els.bar.style.width = `${clamp(sharePct, 0, 100).toFixed(1)}%`;
      els.slider.value = String(activeWatts);
      if (skipInputOverwriteForId !== id) {
        els.input.value = String(activeWatts);
      }
    });

    dom["toggle-ac-eco"].checked = state.appliances.ac.ecoMode;
    dom["badge-ac-eco"].textContent = state.appliances.ac.ecoMode
      ? `Eco Active (<=${APPLIANCE_SPECS.ac.ecoCapWatts} W)`
      : "Eco Mode";

    // 5. CLO7 Configuration Controls Sync
    dom.simModeRadios.forEach((r) => {
      r.checked = r.value === state.config.simulationMode;
    });
    dom.intervalRadios.forEach((r) => {
      r.checked = Number(r.value) === state.config.samplingIntervalSec;
    });
    if (skipInputOverwriteForId !== "config-voltage") {
      dom["config-voltage"].value = String(state.config.voltageRef);
    }
    if (skipInputOverwriteForId !== "config-threshold") {
      dom["config-threshold"].value = String(state.config.thresholdWatts);
    }
    if (skipInputOverwriteForId !== "config-tariff") {
      dom["config-tariff"].value = metrics.tariffRate.toFixed(2);
    }
    dom["config-tariff-slab"].value = state.tariffSelection;

    // 6. Telemetry Chart
    dom["chart-legend-near"].textContent = `85% (${formatNumber(metrics.nearThresholdWatts)} W)`;
    dom["chart-legend-threshold"].textContent = `Limit (${formatNumber(metrics.threshold)} W)`;
    dom["chart-sample-count"].textContent = `${state.history.length} sample${
      state.history.length === 1 ? "" : "s"
    } plotted`;
    dom["next-sample-indicator"].textContent = isAuto
      ? `Sampling every ${state.config.samplingIntervalSec}s`
      : "Manual updates active";

    ChartRenderer.draw(dom["power-chart"], state.history, metrics.threshold, metrics.nearThresholdWatts);

    // 7. Timestamped IoT Telemetry & Action Log Table
    renderTelemetryTable();

    // 8. Live Simulated MQTT Payload (CLO4)
    state.packetCount += 1;
    dom["mqtt-packet-counter"].textContent = `Packet #${state.packetCount}`;
    const packet = TelemetryEngine.buildMqttPacket(metrics);
    dom["mqtt-payload"].textContent = JSON.stringify(packet, null, 2);
  }

  function recordChartPoint(metrics) {
    state.history.push({
      totalWatts: metrics.totalWatts,
      label: formatTime(new Date()),
    });
    if (state.history.length > MAX_CHART_POINTS) {
      state.history.shift();
    }
  }

  function updateAll(pushHistoryPoint, skipInputOverwriteForId, accumulateSession) {
    const metrics = TelemetryEngine.evaluateControlRules();
    if (accumulateSession) {
      const deltaHours = state.config.samplingIntervalSec / 3600;
      const deltaKwh = metrics.totalKw * deltaHours;
      state.sessionKwh += deltaKwh;
      state.sessionCostAed += deltaKwh * metrics.tariffRate;
    }
    if (pushHistoryPoint) {
      recordChartPoint(metrics);
    }
    renderDashboard(metrics, skipInputOverwriteForId);
  }

  /* ========================================================================
     8. Event Binding & Input Handlers
     ======================================================================== */
  function setApplianceWatts(id, newWatts, skipInputOverwrite) {
    const spec = APPLIANCE_SPECS[id];
    const app = state.appliances[id];
    const clamped = Math.round(clamp(newWatts, spec.min, spec.max));

    if (clamped > 0) {
      app.enabled = true;
      app.watts = clamped;
      app.lastActiveWatts = clamped;
    } else {
      app.enabled = false;
      app.watts = 0;
    }

    if (id === "ac" && app.ecoMode && clamped > spec.ecoCapWatts) {
      app.ecoMode = false;
    }

    if (state.autoShedNotice && clamped > 0) {
      state.autoShedNotice = null;
    }

    updateAll(true, skipInputOverwrite ? id : null);
  }

  function setSimulationMode(mode) {
    state.config.simulationMode = mode;
    if (mode === "auto") {
      SensorSimulator.startAutoLoop();
    } else {
      SensorSimulator.stopAutoLoop();
    }
    updateAll(false);
  }

  function resetToDefaults() {
    state.appliances.ac = {
      enabled: true,
      watts: APPLIANCE_SPECS.ac.defaultWatts,
      lastActiveWatts: APPLIANCE_SPECS.ac.defaultOnWatts,
      ecoMode: false,
      preEcoWatts: APPLIANCE_SPECS.ac.defaultWatts,
    };
    state.appliances.fridge = {
      enabled: true,
      watts: APPLIANCE_SPECS.fridge.defaultWatts,
      lastActiveWatts: APPLIANCE_SPECS.fridge.defaultOnWatts,
    };
    state.appliances.fryer = {
      enabled: false,
      watts: APPLIANCE_SPECS.fryer.defaultWatts,
      lastActiveWatts: APPLIANCE_SPECS.fryer.defaultOnWatts,
    };
    state.config = { ...DEFAULT_CONFIG };
    state.tariffSelection = "0.29";
    state.sessionKwh = 0;
    state.sessionCostAed = 0;
    state.autoShedNotice = null;
    state.lastZone = null;
    SensorSimulator.stopAutoLoop();
    hideValidationNotice();

    const baseline = TelemetryEngine.computeMetrics();
    appendTelemetryLog(baseline, "Reset to Defaults (230 V, 3,000 W limit, 0.29 AED/kWh)", "normal");
    updateAll(true);
  }

  function bindEvents() {
    dom["btn-dismiss-validation"].addEventListener("click", hideValidationNotice);

    Object.keys(APPLIANCE_SPECS).forEach((id) => {
      const spec = APPLIANCE_SPECS[id];
      const els = dom.appliances[id];

      els.slider.addEventListener("input", () => {
        hideValidationNotice();
        setApplianceWatts(id, Number(els.slider.value), false);
      });

      els.input.addEventListener("input", () => {
        if (els.input.value.trim() === "") {
          const app = state.appliances[id];
          app.enabled = false;
          app.watts = 0;
          updateAll(false, id);
          return;
        }
        const check = sanitizeNumericInput(els.input.value, spec.min, spec.max, 0, spec.name);
        if (check.adjusted) {
          showValidationNotice(check.notice);
          setApplianceWatts(id, check.value, false);
        } else {
          hideValidationNotice();
          setApplianceWatts(id, check.value, true);
        }
      });

      const commitApplianceInput = () => {
        const check = sanitizeNumericInput(els.input.value, spec.min, spec.max, 0, spec.name);
        if (check.adjusted) {
          showValidationNotice(check.notice);
        }
        setApplianceWatts(id, check.value, false);
      };

      els.input.addEventListener("change", commitApplianceInput);
      els.input.addEventListener("blur", commitApplianceInput);

      els.toggle.addEventListener("change", () => {
        const app = state.appliances[id];
        if (els.toggle.checked) {
          app.enabled = true;
          let restored = app.lastActiveWatts > 0 ? app.lastActiveWatts : spec.defaultOnWatts;
          if (id === "ac" && app.ecoMode) {
            restored = Math.min(restored, spec.ecoCapWatts);
          }
          app.watts = clamp(restored, spec.min, spec.max);
          state.autoShedNotice = null;
        } else {
          if (app.watts > 0) {
            app.lastActiveWatts = app.watts;
          }
          app.enabled = false;
          app.watts = 0;
          if (id === "ac") {
            app.ecoMode = false;
          }
        }
        updateAll(true);
      });
    });

    dom["toggle-ac-eco"].addEventListener("change", () => {
      const ac = state.appliances.ac;
      const cap = APPLIANCE_SPECS.ac.ecoCapWatts;
      if (dom["toggle-ac-eco"].checked) {
        if (!ac.enabled) {
          ac.enabled = true;
          ac.watts = cap;
        }
        ac.preEcoWatts = ac.watts;
        ac.ecoMode = true;
        if (ac.watts > cap) {
          ac.watts = cap;
          ac.lastActiveWatts = cap;
        }
        appendTelemetryLog(
          TelemetryEngine.computeMetrics(),
          `AC Eco Mode enabled (capped <= ${cap} W)`,
          "shed"
        );
      } else {
        ac.ecoMode = false;
        if (ac.enabled && ac.preEcoWatts > ac.watts) {
          ac.watts = clamp(ac.preEcoWatts, APPLIANCE_SPECS.ac.min, APPLIANCE_SPECS.ac.max);
          ac.lastActiveWatts = ac.watts;
        }
      }
      state.autoShedNotice = null;
      updateAll(true);
    });

    dom["auto-shed-toggle"].addEventListener("change", () => {
      state.config.autoLoadShedding = dom["auto-shed-toggle"].checked;
      appendTelemetryLog(
        TelemetryEngine.computeMetrics(),
        `Auto Load-Shedding switched ${state.config.autoLoadShedding ? "ON" : "OFF"}`,
        "normal"
      );
      if (!state.config.autoLoadShedding) {
        state.autoShedNotice = null;
      }
      updateAll(true);
    });

    dom["btn-shed-fryer"].addEventListener("click", () => {
      if (TelemetryEngine.shedAirFryer("Manual Trigger")) {
        state.autoShedNotice = null;
        updateAll(true);
      }
    });

    dom["btn-shed-ac-eco"].addEventListener("click", () => {
      if (TelemetryEngine.enableAcEcoMode("Manual Trigger")) {
        state.autoShedNotice = null;
        updateAll(true);
      }
    });

    dom["btn-dismiss-shed-notice"].addEventListener("click", () => {
      state.autoShedNotice = null;
      updateAll(false);
    });

    dom["btn-clear-log"].addEventListener("click", () => {
      state.eventLog = [];
      updateAll(false);
    });

    dom["sim-mode-pill"].addEventListener("click", () => {
      const next = state.config.simulationMode === "auto" ? "manual" : "auto";
      setSimulationMode(next);
    });

    dom["btn-preset-overload"].addEventListener("click", () => {
      state.autoShedNotice = null;
      state.appliances.ac.enabled = true;
      state.appliances.ac.ecoMode = false;
      state.appliances.ac.watts = 1600;
      state.appliances.ac.lastActiveWatts = 1600;
      state.appliances.fridge.enabled = true;
      state.appliances.fridge.watts = 200;
      state.appliances.fryer.enabled = true;
      state.appliances.fryer.watts = 1600;
      state.appliances.fryer.lastActiveWatts = 1600;
      updateAll(true);
    });

    dom["btn-reset-defaults"].addEventListener("click", resetToDefaults);

    dom.simModeRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        if (radio.checked) {
          setSimulationMode(radio.value);
        }
      });
    });

    dom.intervalRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        if (radio.checked) {
          state.config.samplingIntervalSec = Number(radio.value);
          if (state.config.simulationMode === "auto") {
            SensorSimulator.startAutoLoop();
          }
          updateAll(false);
        }
      });
    });

    const commitVoltageInput = () => {
      const check = sanitizeNumericInput(
        dom["config-voltage"].value,
        100,
        260,
        DEFAULT_CONFIG.voltageRef,
        "Line Voltage Reference"
      );
      if (check.adjusted) {
        showValidationNotice(check.notice);
      }
      state.config.voltageRef = check.value;
      updateAll(false);
    };

    dom["config-voltage"].addEventListener("input", () => {
      const raw = dom["config-voltage"].value.trim();
      if (raw === "") return;
      const val = Number(raw);
      if (!Number.isFinite(val) || val < 0 || val > 260) {
        commitVoltageInput();
      }
    });

    dom["config-voltage"].addEventListener("change", commitVoltageInput);
    dom["config-voltage"].addEventListener("blur", commitVoltageInput);
    dom["config-voltage"].addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commitVoltageInput();
      }
    });

    const commitThresholdInput = () => {
      const check = sanitizeNumericInput(
        dom["config-threshold"].value,
        200,
        10000,
        DEFAULT_CONFIG.thresholdWatts,
        "Overload Threshold"
      );
      if (check.adjusted) {
        showValidationNotice(check.notice);
      }
      state.config.thresholdWatts = check.value;
      updateAll(false);
    };

    dom["config-threshold"].addEventListener("input", () => {
      const raw = dom["config-threshold"].value.trim();
      if (raw === "") return;
      const val = Number(raw);
      if (!Number.isFinite(val) || val < 0 || val > 10000) {
        commitThresholdInput();
      }
    });

    dom["config-threshold"].addEventListener("change", commitThresholdInput);
    dom["config-threshold"].addEventListener("blur", commitThresholdInput);
    dom["config-threshold"].addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commitThresholdInput();
      }
    });

    const applyTariffValue = (rate, skipInputOverwrite) => {
      state.config.tariffRate = rate;
      const formatted = rate.toFixed(2);
      state.tariffSelection = DEWA_SLAB_VALUES.includes(formatted) ? formatted : "custom";
      updateAll(false, skipInputOverwrite ? "config-tariff" : null);
    };

    const commitTariffInput = () => {
      const check = sanitizeNumericInput(
        dom["config-tariff"].value,
        TARIFF_MIN,
        TARIFF_MAX,
        DEFAULT_CONFIG.tariffRate,
        "Electricity Tariff (AED/kWh)",
        2
      );
      if (check.adjusted) {
        showValidationNotice(check.notice);
      }
      applyTariffValue(check.value, false);
    };

    dom["config-tariff"].addEventListener("input", () => {
      const raw = dom["config-tariff"].value.trim();
      if (raw === "") return;
      const val = Number(raw);
      if (!Number.isFinite(val) || val < 0 || val > TARIFF_MAX) {
        commitTariffInput();
        return;
      }
      if (val >= TARIFF_MIN) {
        hideValidationNotice();
        const rounded = Math.round(val * 100) / 100;
        applyTariffValue(rounded, true);
      }
    });

    dom["config-tariff"].addEventListener("change", commitTariffInput);
    dom["config-tariff"].addEventListener("blur", commitTariffInput);
    dom["config-tariff"].addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commitTariffInput();
      }
    });

    dom["config-tariff-slab"].addEventListener("change", () => {
      const selected = dom["config-tariff-slab"].value;
      if (selected === "custom") {
        state.tariffSelection = "custom";
        dom["config-tariff"].focus();
        dom["config-tariff"].select();
        updateAll(false);
        return;
      }
      const parsed = Number(selected);
      if (Number.isFinite(parsed)) {
        hideValidationNotice();
        state.tariffSelection = selected;
        state.config.tariffRate = parsed;
        updateAll(false);
      }
    });

    dom["btn-copy-mqtt"].addEventListener("click", () => {
      const text = dom["mqtt-payload"].textContent;
      const showCopied = () => {
        dom["btn-copy-mqtt"].textContent = "Copied!";
        window.setTimeout(() => {
          dom["btn-copy-mqtt"].textContent = "Copy JSON";
        }, 1400);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showCopied).catch(() => {
          fallbackCopyText(text);
          showCopied();
        });
      } else {
        fallbackCopyText(text);
        showCopied();
      }
    });

    function fallbackCopyText(text) {
      const temp = document.createElement("textarea");
      temp.value = text;
      temp.setAttribute("readonly", "");
      temp.style.position = "fixed";
      temp.style.opacity = "0";
      document.body.appendChild(temp);
      temp.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(temp);
      }
    }

    window.addEventListener("resize", () => {
      const metrics = TelemetryEngine.computeMetrics();
      ChartRenderer.draw(
        dom["power-chart"],
        state.history,
        metrics.threshold,
        metrics.nearThresholdWatts
      );
    });
  }

  /* ========================================================================
     9. Application Bootstrap
     ======================================================================== */
  function init() {
    cacheDom();
    GaugeRenderer.initStaticTracks();
    bindEvents();
    const initialMetrics = TelemetryEngine.computeMetrics();
    appendTelemetryLog(initialMetrics, "Simulation Initialized (NORMAL)", "normal");
    updateAll(true);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
