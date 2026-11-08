# 🐉 Roll for Initiative — D&D Turn Tracker (Discord Activity)

A real-time multiplayer **D&D 5e Initiative Tracker & Turn Notification App** built for **Discord Embedded Activities** (and standalone browsers).

## ✨ Features
- **Sign-In as Dungeon Master or Player**:
  - **Players** enter their Character Name, DEX/Initiative modifier, Max HP, and AC.
  - **Dungeon Master** controls the encounter flow, adds Monsters/NPCs (in batches or individually), and manages all combatants.
- **Built-in d20 Roller OR Physical Dice Entry**:
  - Players can click **Roll d20 + Modifier** or enter their physical tabletop dice roll.
  - Initiative order automatically sorts from highest to lowest, breaking ties using DEX modifier.
- **One-Tap DM Turn Progression & Player Notifications**:
  - When the DM taps **NEXT TURN**, the active turn advances one by one.
  - **Active Player Alert**: The player whose turn just started receives a **full-screen golden alert banner**, a **golden screen-border glow**, a **synthesized heroic horn fanfare**, and a browser notification.
  - **On-Deck Warning**: The player whose turn is *next* receives an **On Deck** toast banner and two-tone chime so they can prepare their spell/attack ahead of time.
  - **DM "Nudge Player" Button**: Re-triggers the visual & audio alert on the active player's screen at any time.
- **HP & Condition Tracking**:
  - Adjust HP (`+` / `-`) and toggle status conditions (`Concentrating`, `Blessed`, `Poisoned`, `Prone`, etc.) live across everyone's screen.

---

## 🚀 Quick Start (Local Multi-Tab Testing)

1. Install dependencies:
   ```bash
   npm.cmd install
   ```
2. Start the server:
   ```bash
   npm.cmd start
   ```
3. Open **http://localhost:3000** in **2 or 3 browser tabs** side-by-side:
   - **Tab 1**: Sign in as **Dungeon Master** (`DM Matt`).
   - **Tab 2**: Sign in as **Adventurer** (`Shadowheart`).
   - **Tab 3**: Sign in as **Adventurer** (`Astarion`).
4. Roll initiative in Tabs 2 & 3, add a couple of Goblins in Tab 1, and click **START COMBAT / NEXT TURN** in Tab 1 to watch the targeted turn notifications fire in Tabs 2 & 3!

---

## 🎮 Running Inside Discord as an Embedded Activity

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Copy your **Application ID** and **Client Secret** (under **OAuth2**) into a `.env` file (copied from `.env.example`):
   ```env
   DISCORD_CLIENT_ID=123456789012345678
   DISCORD_CLIENT_SECRET=your_secret_here
   PORT=3000
   ```
3. Expose your local port `3000` over HTTPS using **Cloudflare Tunnel**:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
4. In the Discord Developer Portal, go to **Activities -> URL Mappings** and set the Root Mapping (`/`) to your `https://xxxx.trycloudflare.com` URL.
5. In **Activities -> Settings**, enable **Activities**.
6. Join any Discord Voice Channel, click the **Rocket Ship (Start an Activity)** icon, and launch your D&D Initiative Tracker!
