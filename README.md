# 🔥 Thermora
### AI-Powered Extreme Heat Risk & Urban Heat Intelligence Platform

> **Where is the heat? → Who is at risk? → Why? → What should we do? → What happens if we take action?**

Thermora is an **AI-powered extreme heat intelligence and decision-support platform** built to transform real-world thermal, environmental, geospatial, exposure, and weather data into actionable heat-risk insights.

Unlike a traditional weather application that simply tells you the temperature, Thermora asks the questions that matter for decisions:

**Where is the heat? Who is exposed? Why is the risk high? What should be done? And what could happen if action is taken?**

Thermora can analyze **entire cities as well as specific geographic areas**, allowing users to compare locations, understand heat conditions, investigate risk drivers, and make better-informed decisions.

<br>

## 🌡️ The Problem

### Extreme Heat Is More Than a Temperature Number

A weather application might tell you:

> **Houston: 40°C**

But that number alone does not answer the questions a resident, emergency manager, city official, business, or outdoor worker actually needs to know.

- Where is the heat most severe?
- How long has the dangerous heat persisted?
- Is humidity making the conditions more stressful?
- Is the heat index significantly higher than the air temperature?
- Is wet-bulb stress becoming a concern?
- How much of the population or critical infrastructure is exposed?
- Are schools, hospitals, or other important locations inside the affected area?
- Is there an official weather alert?
- What actions should be prioritized?
- When is it safer to travel?
- How does one city or area compare with another?
- Is today's situation an isolated event or part of a longer trend?

Traditional weather applications primarily communicate **weather**.

Thermora is designed to communicate **heat risk and what to do about it**.

<br>

## 💡 What Is Thermora?

Thermora is a decision-support layer built on top of real-world environmental and geospatial data.

Its architecture follows a simple principle:

```text
REAL-WORLD DATA
       ↓
THERMAL & ENVIRONMENTAL INTELLIGENCE
       ↓
SPATIAL + EXPOSURE ANALYSIS
       ↓
DETERMINISTIC RISK SCORING
       ↓
EXPLAINABLE INSIGHTS
       ↓
RECOMMENDED ACTIONS
       ↓
AI-ASSISTED DECISION SUPPORT
````

The platform does **not** attempt to invent missing environmental measurements.

If a measurement is unavailable, Thermora communicates that limitation rather than silently fabricating a value.

Only the narrative layer uses an LLM for natural-language generation. The underlying measurements, risk calculations, exposure calculations, alert detection, and decision rules remain grounded in actual data and deterministic logic.

<br>

## 🛰️ Powered by FortyGuard

### Real Thermal Intelligence at the Core

**FortyGuard is the core thermal data source powering Thermora's heat intelligence.**

Instead of relying solely on a single city-wide weather value, Thermora uses FortyGuard's geospatial temperature intelligence to analyze temperature conditions across a selected **Area of Interest (AOI)**.

Thermora integrates with the **FortyGuard Temperature API** to submit heatmap analysis requests for geographic areas and retrieve processed thermal data.

The integration supports the workflow required by FortyGuard's asynchronous processing model:

```text
Thermora
   │
   │ Submit geographic AOI + analysis parameters
   ▼
FortyGuard Temperature API
   │
   │ activity_id
   ▼
Thermora Backend
   │
   │ Poll processing status
   ▼
FortyGuard
   │
   │ Completed
   ▼
GeoJSON Thermal Results
   │
   ▼
PostgreSQL Cache
   │
   ▼
Thermora Intelligence Engine
```

### FortyGuard request example

Thermora can submit a geographic polygon together with parameters such as:

* Area of Interest (AOI)
* Date
* Start time
* Granularity
* Analytic type
* Temperature threshold
* Direction of threshold

For example, Thermora can submit an exceedance analysis such as:

```json
{
  "polygon_aoi": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "properties": {},
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [-95.3798, 29.7504],
              [-95.3598, 29.7504],
              [-95.3598, 29.7704],
              [-95.3798, 29.7704],
              [-95.3798, 29.7504]
            ]
          ]
        }
      }
    ]
  },
  "date_time": {
    "start_date": "2026-08-31",
    "filter_type": 3
  },
  "granularity": 100,
  "analytic_type": "exceedance",
  "threshold": 30.0,
  "direction": "above"
}
```

Thermora also uses FortyGuard thermal analysis such as **TCM** and persistence-related analysis to understand not only how hot an area is, but how heat behaves over time.

<br>

## 🔬 Real FortyGuard GeoJSON Intelligence

FortyGuard responses provide spatially distributed thermal cells rather than a single fabricated city-wide number.

A completed response can contain:

```json
{
  "properties": {
    "tile_id": 382,
    "value": 13.025
  },
  "geometry": {
    "type": "Polygon",
    "coordinates": [...]
  }
}
```

Thermora processes these geospatial features and associated statistics to build its downstream intelligence.

For example, a completed thermal analysis can return statistics such as:

```json
{
  "analytic_type": "persistence",
  "units": "hour",
  "n_cells": 410,
  "min": 12.8367,
  "max": 14.7851,
  "mean": 13.3239
}
```

This means Thermora can work with **real spatial thermal cells and statistical results returned by FortyGuard**, rather than pretending that one weather-station value represents an entire geographic area.

<br>

## ⚡ Why the FortyGuard Integration Matters

FortyGuard provides the thermal intelligence layer that makes Thermora different from a conventional weather dashboard.

Thermora uses FortyGuard to answer:

#### Where is the heat?

Through spatial thermal data and geographic heatmaps.

#### How severe is it?

Through temperature and related thermal analysis.

#### How long does it persist?

Through exceedance and persistence-oriented analysis.

#### What does the spatial pattern look like?

Through GeoJSON thermal cells that can be mapped to geographic areas.

#### Can we analyze a specific area?

Yes.

Thermora can submit an **Area of Interest** rather than limiting analysis to an entire city.

<br>

## 🧠 Thermora's Intelligence Pipeline

Thermora separates **data collection**, **storage**, **analysis**, and **AI explanation**.

```text
                    ┌──────────────────┐
                    │    FortyGuard    │
                    │ Temperature API  │
                    └────────┬─────────┘
                             │
                    Thermal / Heat Data
                             │
                             ▼
┌──────────────┐      ┌──────────────┐
│ OpenStreetMap│─────▶│  PostgreSQL  │
│   Exposure   │      │    Cache     │
└──────────────┘      └──────┬───────┘
                             │
┌──────────────┐             │
│ NWS / NOAA   │─────────────┤
│ Weather      │             │
│ Alerts       │             │
└──────────────┘             ▼
                    ┌──────────────────┐
                    │ Thermora Engine  │
                    └────────┬─────────┘
                             │
             ┌───────────────┼────────────────┐
             ▼               ▼                ▼
       Risk Score       Impact Score     Emergency Mode
             │               │                │
             └───────────────┼────────────────┘
                             ▼
                    ┌──────────────────┐
                    │ AI / Agent Layer │
                    └────────┬─────────┘
                             ▼
                    Actionable Insights
```

<br>

## 📊 Heat Risk Score

### Explainable 0–100 Risk Model

Thermora calculates a deterministic **Heat Risk Score from 0–100**.

The score combines multiple measurable environmental factors rather than relying on temperature alone.

Depending on data availability, the model incorporates factors such as:

* Heat Index
* Wet-bulb stress
* Temperature
* Heat persistence
* Threshold exceedance
* Air Quality Index
* Environmental conditions

The important part is that the score is **explainable**.

Instead of:

> "AI says the risk is High."

Thermora can explain:

```text
HEAT RISK: 78 / 100

Heat Index       █████████░  High contribution
Wet-Bulb Stress  ████████░░  Significant contribution
Persistence      ███████░░░  Significant contribution
Exceedance       ████████░░  Significant contribution
Air Quality      ████░░░░░░  Moderate contribution
```

This allows users to understand **why** the score exists.

<br>

## 👥 People Impact Score

Heat risk alone is not enough.

A location with extreme heat but very little exposure may require a different response from an equally hot area containing critical infrastructure and large numbers of exposed people.

Thermora therefore separates:

```text
HEAT RISK
     +
REAL-WORLD EXPOSURE
     ↓
PEOPLE IMPACT
```

The **People Impact Score** combines the deterministic heat risk with real exposure information.

This creates a more useful prioritization model:

```text
Hot + Low Exposure
        ≠
Hot + High Exposure
```

<br>

## 🗺️ Exposure Intelligence

Thermora uses **OpenStreetMap-based geospatial information** to understand what exists inside the analyzed area.

This can include:

* Schools
* Hospitals
* Buildings
* Roads
* Other mapped infrastructure

The purpose is not to invent demographic statistics.

Instead, Thermora uses real mapped features to understand **what may be exposed inside a hot geographic area**.

For example:

```text
THERMAL DATA
      +
GEOGRAPHIC EXPOSURE
      ↓
IMPACT PRIORITIZATION
```

This helps turn a heatmap into a decision-support system.

<br>

## 🚨 Emergency Mode

Thermora includes a deterministic **Emergency Mode** designed to turn high-risk conditions into prioritized actions.

Emergency Mode can be triggered by conditions such as:

* High Heat Risk Score
* High People Impact Score
* Significant environmental stress
* Official weather alerts

The important distinction:

**Emergency Mode is rules-based, not LLM-generated.**

This makes it:

* Fast
* Auditable
* Predictable
* Reproducible

Instead of allowing an AI model to randomly decide whether an emergency exists, Thermora evaluates explicit conditions.

The system can then produce action priorities such as:

```text
1. Reduce outdoor exposure
2. Prioritize vulnerable/high-exposure locations
3. Monitor official weather alerts
4. Shift outdoor activities to safer hours
5. Increase heat-safety measures
```

Recommendations are connected to the factors responsible for the elevated risk.

<br>

## 🌦️ NWS Weather Alerts

Thermora also integrates official weather-alert information from the **U.S. National Weather Service (NWS)**.

This creates an important separation:

```text
THERMORA MODEL
"Our calculated heat risk is high."

             +

OFFICIAL ALERT
"A government weather warning is active."
```

These are **not treated as the same thing**.

Thermora keeps model-derived risk and official government alerts visibly distinct so that users can understand the difference between:

* What Thermora calculates from environmental data
* What an official authority has issued as a warning

<br>

## 📖 Heat Story

## Turning Data Into a Human-Readable Explanation

Raw environmental data can be difficult to interpret.

Thermora's **Heat Story** converts the available observations and analysis into a plain-language narrative.

It explains things such as:

* How today's heat developed
* Which factors contributed to the risk
* How persistent the heat has been
* What environmental conditions matter
* What users should pay attention to

### Important design principle

Thermora explicitly separates:

```text
OBSERVED
────────
What has actually been measured

FORECAST
────────
What is expected to happen
```

This prevents forecasts from being presented as historical observations.

The Heat Story is the primary part of the system where an LLM is used to generate natural-language prose.

The underlying measurements and calculations remain grounded in actual system data.

<br>

## 🤖 Local Heat Advisor

Different people need different answers from the same heat data.

Thermora provides contextual advice for multiple audiences, including:

* 🧍 Resident
* 🦺 Outdoor Worker
* 🌾 Farmer
* 🏙️ City Official
* 🚑 Emergency Manager
* 🏢 Business

The important principle is:

```text
SAME REAL DATA
       ↓
DIFFERENT CONTEXT
       ↓
DIFFERENT EXPLANATION
```

The underlying risk score does not change simply because the user changes audience.

The interpretation does.

<br>

## 🤖 AI Heat Agent

Thermora includes an AI agent powered by **Groq**.

But it is not designed to be a chatbot that simply generates plausible-sounding heat advice.

The agent is designed around **tool use**.

A user can ask:

> "What should I do about the heat in Houston today?"

Instead of guessing, the agent can investigate using Thermora's real intelligence functions.

Conceptually:

```text
USER QUESTION
      ↓
AI AGENT
      ↓
CALL REAL THERMORA TOOLS
      ↓
Risk Score
Impact Score
Emergency Mode
Heat Story
Alerts
      ↓
GROUNDED RESPONSE
```

The agent therefore acts as an interface to Thermora's underlying intelligence rather than replacing it.

<br>

## 🛣️ Heat-Safe Routing

Thermora extends heat intelligence beyond static maps.

The **Heat-Safe Routing** feature evaluates candidate routes according to heat exposure.

Rather than assuming:

> "The entire route has one temperature."

Thermora can evaluate heat conditions at multiple points along a route.

Conceptually:

```text
Route A
●──●──●──●──●
🔥  🔥  🔥  🔥  🔥

Route B
●──●──●──●──●
🌡️  🌤️  🌤️  🌤️  🌡️
```

This allows routes to be compared according to thermal exposure.

Thermora also includes a **Best Time to Travel** concept, comparing upcoming hours for a fixed location to identify safer periods based on available heat data.

<br>

## ⏱️ Time Comparison

Heat is dynamic.

Thermora allows users to compare heat conditions across time rather than treating a single measurement as the complete story.

Users can investigate:

* Different hours
* Different dates
* Heat persistence
* Exceedance duration
* Historical conditions
* Upcoming conditions where forecast data is available

This helps answer:

> **"Is the heat getting better, worse, or simply lasting longer?"**

<br>

## 🏙️ City Comparison

Thermora supports **city-to-city comparison**.

Users can compare cities using measurable indicators such as:

* Temperature
* Heat Index
* Wet-bulb stress
* Persistence
* Exceedance
* Air Quality
* Heat Risk
* People Impact

For example:

```text
CITY A
Heat Risk:     72
Impact:        65
Persistence:   High

CITY B
Heat Risk:     61
Impact:        78
Persistence:   Moderate
```

This demonstrates an important principle:

> The city with the highest heat is not necessarily the city with the highest overall impact.

<br>

## 🔬 Research Mode

Thermora also includes a research-oriented experience for exploring heat conditions systematically.

The research functionality is intended to help users investigate relationships between:

* Heat
* Environmental conditions
* Persistence
* Exposure
* Risk
* Time
* Locations

Rather than presenting only a single "hot/not hot" answer, Thermora provides a way to investigate the underlying data and trends.

<br>

## 💾 Data Architecture

Thermora uses **PostgreSQL** as its persistent data layer.

A central concept is the `location_features` dataset.

It stores normalized heat/environmental features for downstream analysis.

Conceptually:

```text
location_features

city
date
hour
temperature
heat_index
wet_bulb
humidity
aqi
exceedance_hours
persistence_hours
...
```

The architecture separates observed and forecast information so that the system does not accidentally treat a prediction as a measurement.

<br>

## ⚡ Intelligent Caching

FortyGuard requests are asynchronous and can be computationally expensive.

Thermora therefore uses request-level caching.

A request is associated with a signature based on the relevant parameters, such as:

```text
LOCATION
+
TIME
+
ANALYSIS PARAMETERS
+
REQUEST TYPE
```

If the same request has already been completed, Thermora can reuse the stored result instead of unnecessarily submitting the same request again.

This provides:

* Reduced API usage
* Lower latency
* Better reliability
* Faster repeated analysis
* Persistent historical data

Example backend behavior:

```text
[DB] Cache hit for heatmap
```

This architecture is particularly important when working with an external asynchronous analytics API.

<br>

## 🔄 Asynchronous FortyGuard Processing

FortyGuard heatmap analysis is not treated as an instant request.

Thermora handles the full lifecycle:

```text
SUBMIT
  ↓
activity_id
  ↓
POLL
  ↓
Processing
  ↓
POLL
  ↓
Completed
  ↓
STORE
  ↓
ANALYZE
```

Example successful submission:

```text
Heatmap Submitted Successfully

activity_id:
ae2e57ae-0982-4d2a-b4dd-a16b6eb86ce6
```

Thermora's backend then polls the corresponding status endpoint until processing completes.

This is handled by the backend rather than forcing the frontend to implement the external API workflow.

<br>

## 🧱 System Architecture

```text
                    ┌─────────────────────┐
                    │      React UI       │
                    │     + Vite          │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │     FastAPI         │
                    │      Backend        │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
 ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
 │   FortyGuard   │   │ OpenStreetMap  │   │    NWS/NOAA    │
 │ Temperature API│   │    Exposure    │   │     Alerts     │
 └───────┬────────┘   └────────────────┘   └────────────────┘
         │
         ▼
 ┌─────────────────────────────────────┐
 │            PostgreSQL               │
 │                                     │
 │ Raw Activities                      │
 │ Thermal Results                     │
 │ Location Features                   │
 │ Alerts                              │
 │ Exposure Cache                      │
 │ Request Cache                       │
 └──────────────────┬──────────────────┘
                    │
                    ▼
        ┌──────────────────────────┐
        │ Thermora Intelligence    │
        │                          │
        │ Risk Engine              │
        │ Impact Engine            │
        │ Emergency Rules          │
        │ Routing                  │
        │ Comparisons              │
        │ Historical Analysis      │
        └────────────┬─────────────┘
                     │
                     ▼
             ┌───────────────┐
             │   Groq Agent  │
             │ + Heat Story  │
             └───────────────┘
```

<br>

# 🛠️ Technology Stack

## Frontend

* React
* Vite
* JavaScript
* Interactive geospatial visualizations
* Responsive dashboard interface

## Backend

* Python
* FastAPI
* Uvicorn
* SQLAlchemy
* Pydantic

## Database

* PostgreSQL

## External Intelligence

* **FortyGuard Temperature API** — thermal and heat intelligence
* **OpenStreetMap** — geospatial exposure information
* **NWS / NOAA** — official weather alerts

## AI

* Groq-powered tool-using agent
* LLM-generated Heat Story narrative

<br>

# 📂 Project Structure

```text
Thermora/
│
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── ...
│   │
│   ├── requirements.txt
│   └── .env
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── ...
│   │
│   ├── package.json
│   └── vite.config.js
│
├── README.md
└── ...
```

<br>

## 🚀 Running Thermora Locally

### 1. Clone the repository

```bash
git clone <YOUR_REPOSITORY_URL>
cd Thermora
```

<br>

### 🐍 Backend Setup

Move into the backend:

```bash
cd backend
```

Create a virtual environment:

```bash
python -m venv venv
```

Activate it on Windows:

```powershell
venv\Scripts\activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Start the FastAPI backend:

```bash
uvicorn app.main:app --reload
```

The backend will run at:

```text
http://127.0.0.1:8000
```

<br>

### ⚛️ Frontend Setup

Open another terminal:

```bash
cd frontend
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

The frontend will normally be available at:

```text
http://localhost:5173
```

Configure the frontend API URL using:

```text
VITE_API_URL
```

<br>

### 🔐 Environment Variables

Create a `.env` file in the backend.

Example:

```env
FORTYGUARD_API_KEY=your_fortyguard_api_key
FORTYGUARD_BASE_URL=https://api.fortyguard.com/v1

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password
POSTGRES_DB=thermora

LOG_LEVEL=DEBUG

FRONTEND_ORIGIN=http://localhost:5173

POLL_INTERVAL_SECONDS=5
POLL_MAX_ATTEMPTS=120
```

For AI functionality, configure the required Groq credentials according to your deployment environment.

<br>

## 🔌 Example Backend Endpoints

Thermora exposes backend endpoints for different parts of the intelligence pipeline.

Examples include:

```text
GET  /api/status
GET  /api/cities

POST /api/heatmap
GET  /api/heatmap/status

POST /api/exposure

GET  /api/cities/{city}/alerts

GET  /api/cities/{city}/risk-score
```

The exact available endpoints may evolve as Thermora continues to develop.

<br>

## 🧪 Example Real Backend Flow

A typical heat analysis can look like:

```text
User selects Houston
        ↓
Thermora checks PostgreSQL cache
        ↓
Existing data reused if available
        ↓
Otherwise submit FortyGuard analysis
        ↓
Receive activity_id
        ↓
Poll FortyGuard
        ↓
Processing
        ↓
Completed
        ↓
Receive thermal GeoJSON/statistics
        ↓
Store results
        ↓
Calculate Thermora Risk Score
        ↓
Calculate People Impact
        ↓
Check official alerts
        ↓
Generate actionable insights
```

<br>

## 🧭 Thermora's Core Product Flow

The entire platform can be summarized as:

```text
🔥 FIND THE HEAT
        ↓
📍 UNDERSTAND THE AREA
        ↓
📊 MEASURE THE CONDITIONS
        ↓
⚠️ CALCULATE THE RISK
        ↓
👥 UNDERSTAND THE IMPACT
        ↓
🚨 DETECT EMERGENCY CONDITIONS
        ↓
🧠 EXPLAIN WHAT IS HAPPENING
        ↓
💡 RECOMMEND ACTION
        ↓
🛣️ FIND SAFER OPTIONS
        ↓
📈 COMPARE TIME & LOCATIONS
```

<br>

## 🎯 What Makes Thermora Different?

### 1. It is not just a weather app

Weather tells you what the atmosphere is doing.

Thermora attempts to translate that information into **risk and decisions**.

### 2. It uses real thermal intelligence

The core heatmap data comes from **FortyGuard**, rather than fabricated sample temperatures.

### 3. It works spatially

Thermora can analyze both cities and specific geographic areas.

### 4. Its risk model is explainable

Risk is calculated using explicit measurable factors.

### 5. Heat and exposure are separated

Thermora distinguishes:

```text
How dangerous is the heat?
```

from:

```text
How much real-world exposure exists?
```

### 6. Official alerts remain separate

Thermora's calculated risk is not presented as an official government warning.

### 7. AI is used where it adds value

LLMs are primarily used for language and agentic investigation—not for inventing environmental measurements.

### 8. It is built for action

The objective is not simply:

> "It is hot."

The objective is:

> **"Here is what is happening, why it matters, who or what is exposed, and what you can do next."**

<br>

## 🏆 Hackathon Context

Thermora was developed for the **Global AI Hackathon — Building the World's Temperature AI**, leveraging FortyGuard's Temperature API as a core component of the platform.

The project focuses on turning temperature intelligence into practical decision support for cities, organizations, and individuals.

### Relevant themes

* Resilient Cities & Infrastructure
* Government & Environment
* Data Analysis & Correlation
* Agentic AI
* Future Buildings & Energy

<br>

## 🔥 The Vision

Extreme heat is becoming an increasingly important urban challenge.

But solving the problem requires more than knowing that temperatures are high.

We need to understand:

```text
WHERE
the heat is happening

WHY
the conditions are dangerous

WHO / WHAT
is exposed

HOW LONG
the heat persists

WHAT
actions should be prioritized

WHEN
conditions may be safer

AND WHETHER
an intervention could change the outcome
```

Thermora is an attempt to connect those pieces into one intelligence layer.

<br>

## 🧠 The Philosophy

Thermora follows one core rule:

> **Nothing is invented when real data is available.**

The platform distinguishes between:

* Observed data
* Forecast data
* Official alerts
* Deterministic calculations
* AI-generated explanations

That distinction matters.

Because when people are making decisions during extreme heat, **confidence without evidence can be dangerous.**

Thermora therefore aims to make heat intelligence:

**Real. Explainable. Spatial. Actionable.**

<br>

## Built With ❤️ for the Global AI Hackathon

**Thermora — AI-Powered Extreme Heat Risk & Urban Heat Intelligence Platform**

🔥 Powered by real thermal intelligence from **FortyGuard**.

<br>

## 👥 Built by Team The Outliers

**Thermora was built by a two-person team — The Outliers.**

We combined our skills in **AI, data analysis, backend engineering, geospatial intelligence, and frontend development** to build an end-to-end platform for understanding and responding to extreme urban heat.

<br>

## ⭐ Show Your Support

If you find Thermora interesting or useful, **please consider giving the project a ⭐ on GitHub!**

Your support means a lot to **The Outliers** and helps us continue improving Thermora. 🔥

> **Two people. One idea. Real data. One goal: turn heat intelligence into decisions.**

