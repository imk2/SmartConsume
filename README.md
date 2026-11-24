# SmartIOT — Smart Energy Monitoring & Load-Shedding Dashboard

A zero-dependency, browser-based IoT simulation dashboard for monitoring household electricity consumption across three high-impact appliances (**Air Conditioner**, **Refrigerator**, and **Air Fryer**) and preventing circuit overloads through an automated **Virtual Eco-Relay** load-shedding controller.

Built strictly with **plain HTML5, CSS3, and vanilla JavaScript** (`index.html`, `style.css`, `script.js`)—requiring no external frameworks, paid APIs, cloud services, or physical hardware.

---

## Project Purpose

Residential circuits frequently experience peak-demand overloads when heavy inductive and heating loads run simultaneously. **SmartIOT** demonstrates core IoT sensing, edge decision logic, user-configurable telemetry parameters (**CLO7**), and protocol/hardware abstraction (**CLO4**) in an interactive local dashboard:

- **Air Conditioner:** `0 – 2,500 W` (Default: `1,400 W`, ON; supports **Eco Mode** capped at `<= 800 W`)
- **Refrigerator:** `0 – 400 W` (Default: `180 W`, ON; continuous compressor cycle profile)
- **Air Fryer:** `0 – 1,800 W` (Default: `0 W`, OFF; restores `1,500 W` or last active load when switched ON)

---

## IoT Architecture & Protocol Model (CLO4)

> **Simulation Notice:** This project is a **100% local browser simulation** with **no physical hardware, live Wi-Fi telemetry transmission, or external MQTT broker**. All sensor waveforms, relay states, and MQTT JSON packets are generated locally inside `script.js`.

```text
[1. Sensing Layer (Modeled)]       [2. Edge MCU (JS Engine)]          [3. Actuation & Telemetry]
SCT-013 AC Current Sensor    --->  ESP32 Microcontroller Model  --->  Virtual Eco-Relay (GPIO)
ZMPT101B AC Voltage Sensor         (script.js TelemetryEngine)        Simulated Wi-Fi / MQTT JSON
```

1. **Modeled Physical Sensors:**
   - **SCT-013:** Non-invasive split-core AC current transformer modeled per branch/total load.
   - **ZMPT101B:** Isolated single-phase AC line voltage transformer modeled around the configurable `230 V` RMS reference.
2. **Modeled Edge Microcontroller (`ESP32` via `script.js`):**
   - Reads manual user controls or generates bounded stochastic load fluctuations at the selected sampling interval (`1s`, `2s`, or `5s`).
   - Computes total active power in Watts (`W`) and Kilowatts (`kW`), derives line current (`I = P / V`), evaluates threshold zones, and drives the Virtual Eco-Relay.
3. **Modeled Communication Protocol (`Wi-Fi / MQTT`):**
   - Formats live readings into a structured JSON telemetry payload on topic `home/smartiot/esp32-node-01/telemetry` (inspectable and copyable in the UI) without sending traffic over a network.

---

## Sensor Configuration Options (CLO7)

Inside the **IoT Sensor Configuration** panel, users can configure:

| Parameter | Options / Range | Default | Description |
| :--- | :--- | :--- | :--- |
| **Simulation Mode** | `Manual` / `Live Auto-Simulation` | `Manual` | Choose between direct manual inputs or periodic automatic load fluctuations. |
| **Sampling Interval** | `1s`, `2s`, `5s` | `2s` | Controls how frequently Live Auto-Simulation samples and updates telemetry & charts. |
| **Line Voltage Reference** | `100 – 260 V AC` | `230 V` | Voltage reference used to compute derived line current (`I = P / V`). |
| **Overload Threshold** | `200 – 10,000 W` | `3,000 W` | Maximum allowable circuit load before triggering `OVERLOAD ALERT`. |
| **Electricity Tariff** | `0.01 – 2.00 AED/kWh` | `0.29 AED/kWh` | Configurable energy tariff with DEWA residential slab presets (incl. `0.06` fuel surcharge): **Green (`0.29`)**, **Yellow (`0.34`)**, **Orange (`0.38`)**, **Red (`0.44`)**, or **Custom**. |
| **Auto Load-Shedding** | `ON` / `OFF` | `OFF` | Enables automatic Virtual Eco-Relay intervention when `Total > Threshold`. |

---

## Calculation, Cost Tracking & Decision Rule Logic

### 1. Load & Cost Formulas
$$\text{Total Consumption (W)} = P_{\text{Air Conditioner}} + P_{\text{Refrigerator}} + P_{\text{Air Fryer}}$$

$$\text{Power (kW)} = \frac{\text{Total Consumption (W)}}{1000}, \qquad \text{Line Current (A)} = \frac{\text{Total Consumption (W)}}{V_{\text{ref}}}$$

$$\text{Live Cost Rate (AED/hr)} = \frac{\text{Total W}}{1000} \times \text{tariffRate}$$

$$\text{Projected Monthly Cost (AED/mo)} = \frac{\text{Total W}}{1000} \times 24 \times 30 \times \text{tariffRate}$$

- **Per-Appliance Hourly Cost:** Each appliance card also displays its live individual cost rate (`(Appliance W / 1000) * tariffRate` in `AED/hr`).
- **Cumulative Session Tracking:** During **Live Auto-Simulation**, each sampling tick ($\Delta t = \text{samplingIntervalSec} / 3600\text{ hr}$) accumulates `Session Energy (kWh)` and `Session Cost (AED)`, resetting to `0` (and restoring `0.29 AED/kWh`) when **Reset Defaults** is clicked.

### 2. Three-Tier Visual Status & Overload Decision Rule

| Total Load Condition | System Status | Overload Alert | Virtual Eco-Relay | UI Status Badge |
| :--- | :--- | :--- | :--- | :--- |
| `Total < 85% of Threshold` | `NORMAL` | `OFF` | `STANDBY` | **Green** (`Normal`) |
| `85% <= Total <= Threshold` | `NORMAL` | `OFF` | `STANDBY` | **Yellow** (`Near Threshold`) |
| `Total > Threshold` | `OVERLOAD ALERT` | `ON` | `ACTIVE` | **Red** (`Overload`) |

### 3. Virtual Eco-Relay Load-Shedding Action
When `Total Consumption > Overload Threshold`:
- **Manual Mode (`Auto Load-Shedding = OFF`):** Displays the red `OVERLOAD ALERT` banner and enables one-click buttons to **Switch Air Fryer OFF** or **Set AC to Eco Mode (`<= 800 W`)**.
- **Automatic Mode (`Auto Load-Shedding = ON`):** Automatically executes cascading load reduction:
  1. Switches the **Air Fryer OFF** first (preserving its previous setpoint for quick restoration).
  2. If total demand still exceeds the threshold, switches the **Air Conditioner to Eco Mode** (capping output at `<= 800 W`).
- Every threshold crossing (`>= 85%`, `> Threshold`, return to normal) and relay action is recorded with a timestamp in the **IoT Telemetry & Action Log** table (`Time`, `AC W`, `Fridge W`, `Air Fryer W`, `Total W`, `Action Taken`).

---

## Project File Structure

```text
SmartIOT/
├── index.html                  # Semantic dashboard layout, SVG power gauge, appliance cards, CLO4/CLO7 panels, and log table
├── style.css                   # Responsive dark dashboard styling, color-coded badges, gauge & table styles
├── script.js                   # Simulation engine, input validation, overload/Eco-Relay logic, canvas chart, and MQTT JSON builder
├── README.md                   # Project documentation, architecture overview, and usage instructions
└── SmartIOT_Lab_Report.pdf     # Final lab submission PDF report (companion submission deliverable)
```

*(Note: Ensure `index.html`, `style.css`, and `script.js` remain in the same directory when running locally.)*

---

## How to Run Locally

### Option 1: Directly in Any Web Browser (Fastest)
1. Download or clone this repository to your computer.
2. Open the project folder (`SmartIOT/`).
3. Double-click **`index.html`** (or right-click **Open With** -> Chrome, Firefox, Edge, or Safari).
   - Because `script.js` uses classic `<script defer>` loading with no external modules or network calls, it runs immediately over `file://`.

### Option 2: Using VS Code
#### Using the Live Server Extension
1. Open the project folder in **Visual Studio Code** (`File -> Open Folder...`).
2. Install the **Live Server** extension (`ritwickdey.LiveServer`) if not already installed.
3. Right-click **`index.html`** in the VS Code Explorer and select **`Open with Live Server`**.
4. Your browser will open at `http://127.0.0.1:5500/index.html`.

#### Using the VS Code Integrated Terminal
1. Open the VS Code integrated terminal (``Ctrl + ` `` or **Terminal -> New Terminal**) inside the project folder.
2. Start a local static server with Python:
   ```bash
   python3 -m http.server 8000
   ```
3. Open `http://localhost:8000` in your web browser.

---

## Quick Verification Walkthrough

1. **Normal State:** On load (`1,400 W + 180 W + 0 W = 1,580 W`), verify **Status = `NORMAL`**, **Overload Alert = `OFF`**, and **Virtual Eco-Relay = `STANDBY`** (Green badges).
2. **Exact Boundary (`3,000 W`):** Set AC = `1,400 W`, Fridge = `200 W`, Air Fryer = `1,400 W` (`Total = 3,000 W`). Verify badges turn **Yellow (`Near Threshold >= 85%`)** while **Status remains `NORMAL`** and **Alert remains `OFF`**.
3. **Overload & Auto-Shedding:** Click **Demo Overload** (`3,400 W > 3,000 W`) to trigger **Red `OVERLOAD ALERT`**. Toggle **Auto Load-Shedding** `ON` to observe the Virtual Eco-Relay automatically switching the Air Fryer `OFF` and logging both events in the **IoT Telemetry & Action Log** table.
4. **Input Validation:** Enter out-of-range values (e.g., `3200` on AC or `-100` on Air Fryer) to verify automatic clamping and the inline validation banner.

---

## Limitations & Future Real-Hardware Improvements

### Current Limitations
- **Simulated Telemetry Only:** Wattage fluctuations are generated stochastically in JavaScript rather than sampled from physical AC mains wiring.
- **Unity Power Factor Assumption:** Derived current uses $I = P / V_{\text{ref}}$ without modeling reactive power or phase angle ($\cos \phi$) for inductive compressor motors.
- **No Persistent Storage:** Telemetry history and event logs reside in browser memory and reset on page reload.
- **No Live Broker Transport:** MQTT payloads are previewed locally in JSON format rather than transmitted over TCP/WebSockets to a broker.

### Future Real-Hardware Improvements
- **ESP32 + Physical Sensor Integration:** Sample true RMS current and voltage via **SCT-013** and **ZMPT101B** connected to ESP32 ADC pins (e.g., using `EmonLib`) to measure real, apparent, and reactive power (`PF`).
- **Physical Solid-State Relay (SSR) Actuation:** Connect an opto-isolated relay module to ESP32 GPIO pins to physically switch non-essential high-draw outlets or send IR/smart-plug Eco commands to the AC.
- **Live MQTT & Time-Series Backend:** Publish TLS-secured telemetry (`MQTTS`) to a Mosquitto or EMQX broker feeding **Node-RED**, **InfluxDB**, and **Grafana** for multi-day `kWh` energy tracking and billing analytics.
- **Browser Persistence & Export:** Add `localStorage` persistence and CSV/JSON export for the Telemetry & Action Log.
# SmartConsume
