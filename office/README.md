# Final Battle

A cinematic 3D battlefield that shows every project you're running and the agents working on them.

![Final Battle preview](preview.png)

- **Each project is a battle zone** with its own terrain (Lava Fields, Frost Peaks, Ancient Ruins, Wild Forest, Dune Sea) and a **boss**. The boss's health bar is the project's remaining work: it drops as your agents' `progress` goes up, and the boss falls when every agent in the zone is `done`.
- **Agents are heroes**:
  - **Fighting** (`working`): attacking the boss with magic bolts
  - **Resting** (`idle`): heads to the campfire now and then
  - **Needs backup** (`needs_you`): a red signal beam rises from them, with a bubble saying what they need
  - **Down** (`error`): knocked flat with dizzy stars
  - **Victory** (`done`): celebrating
- **You're the commander** at the red tent. Its beacon flashes while anyone needs you.
- **The "Needs you" panel** lists every hero waiting on you. Click one to fly to them; **Mark handled** clears it in this browser until they post a new update.
- **Alerts**: a chime when something new needs you (after you've clicked the page once), optional desktop notifications, and the count in the tab title.
- Drag to rotate, right-drag to pan, scroll to zoom. Hero names appear when you hover or zoom in. **Demo** shuffles statuses so you can watch it move.

## Feeding it your real projects

The page reads `data.json` and checks it again every 30 seconds. Each agent looks like this:

```jsonc
{
  "id": "mkt-social",              // unique and stable
  "name": "Social",
  "role": "Social posts",
  "status": "needs_you",           // working | idle | needs_you | error | done
  "task": "10 posts drafted",
  "progress": 0.9,                  // 0..1
  "updated": "2026-11-20T19:30:00Z",// change this whenever the status changes
  "action": {                       // shown when status is needs_you or error
    "title": "Approve post schedule",
    "detail": "Posts are queued for Mon/Wed/Fri at 9am.",
    "link": "https://…"              // optional, http(s) only
  }
}
```

Projects have `id`, `name`, `color` (hex), `description` and `agents`. The top-level `owner.name` labels your desk.

There are two ways to keep it current:

1. **Edit `office/data.json`** in this repo, either by hand or by having your agents commit to it. GitHub Pages redeploys the site and the open page picks up the change on its next check.
2. **Point it at any JSON URL**: `…/office/?data=https://example.com/agents.json`. This can be a raw gist, a small API, or a file your agents write to. The server must allow cross-origin requests.

Add `?demo` to the URL to start in demo mode.

The look (lighting, glow, haze, embers) is built with Three.js post-processing; all colours live at the top of `office.js` (`TERRAINS`, `STATUS`) and in `style.css`.

## Running locally

Browsers block `fetch` from `file://`, so serve the folder:

```sh
cd office && python3 -m http.server 8000
# open http://localhost:8000
```

It uses Three.js from the jsDelivr CDN and has no build step.
