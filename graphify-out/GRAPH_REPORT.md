# Graph Report - src/main  (2026-05-28)

## Corpus Check
- Corpus is ~6,477 words - fits in a single context window. You may not need a graph.

## Summary
- 124 nodes · 212 edges · 6 communities (3 shown, 3 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Bluetooth Call & PBAP|Bluetooth Call & PBAP]]
- [[_COMMUNITY_Main Process Orchestration|Main Process Orchestration]]
- [[_COMMUNITY_Bluetooth Media & Sync|Bluetooth Media & Sync]]
- [[_COMMUNITY_Bluetooth State Machine|Bluetooth State Machine]]
- [[_COMMUNITY_IPC Bridges & Types|IPC Bridges & Types]]
- [[_COMMUNITY_AudioCapture Service|AudioCapture Service]]

## God Nodes (most connected - your core abstractions)
1. `BluetoothManager` - 49 edges
2. `Socket` - 13 edges
3. `AudioCapture` - 8 edges
4. `BluetoothManager` - 7 edges
5. `Main Process Entry` - 7 edges
6. `unwrapVariant()` - 6 edges
7. `unwrapVariants()` - 5 edges
8. `Canbus` - 5 edges
9. `ExtraConfig` - 5 edges
10. `Socket (socket.io Server)` - 5 edges

## Surprising Connections (you probably didn't know these)
- `Canbus` --references--> `CanConfig`  [EXTRACTED]
  Canbus.ts → Globals.ts
- `Canbus` --references--> `Socket`  [EXTRACTED]
  Canbus.ts → Socket.ts
- `Socket` --references--> `ExtraConfig`  [EXTRACTED]
  Socket.ts → Globals.ts
- `PiMost` --references--> `Socket`  [EXTRACTED]
  PiMost.ts → Socket.ts
- `AudioCapture` --semantically_similar_to--> `BluetoothManager`  [INFERRED] [semantically similar]
  src/main/AudioCapture.ts → src/main/Bluetooth.ts

## Hyperedges (group relationships)
- **Audio PCM IPC Pipeline: parec → AudioCapture → IPC → Preload → AudioWorklet** — main_audiocapture, preload_index, renderer_audioworklet [EXTRACTED 0.95]
- **Bluetooth D-Bus Bridge: BluetoothManager ↔ Preload BtApi ↔ Renderer** — main_bluetooth, preload_index, renderer_app [EXTRACTED 0.95]
- **Main Process Orchestration: index.ts instantiates Socket, Canbus, Bluetooth, AudioCapture** — main_index, main_socket, main_bluetooth, main_audiocapture, main_canbus [EXTRACTED 1.00]

## Communities (6 total, 3 thin omitted)

### Community 1 - "Main Process Orchestration"
Cohesion: 0.11
Nodes (15): Canbus, CanMask, CanConfig, CanMessage, ExtraConfig, KeyBindings, Most, appPath (+7 more)

### Community 2 - "Bluetooth Media & Sync"
Cohesion: 0.11
Nodes (16): BtDevice, CallContact, CallState, CallStatus, Contact, ContactsState, HFP_UUIDS, MediaState (+8 more)

### Community 4 - "IPC Bridges & Types"
Cohesion: 0.19
Nodes (15): AudioCapture, BluetoothManager, Canbus, Globals (ExtraConfig, KeyBindings, CanConfig), Main Process Entry, PiMost, Socket (socket.io Server), parec-based Audio Capture replacing getUserMedia (+7 more)

## Knowledge Gaps
- **25 isolated node(s):** `DEFAULT_TARGETS`, `BtDevice`, `PhoneState`, `MediaState`, `CallStatus` (+20 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `BluetoothManager` connect `Bluetooth Call & PBAP` to `Main Process Orchestration`, `Bluetooth Media & Sync`, `Bluetooth State Machine`?**
  _High betweenness centrality (0.494) - this node is a cross-community bridge._
- **Why does `AudioCapture` connect `AudioCapture Service` to `Main Process Orchestration`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **What connects `DEFAULT_TARGETS`, `BtDevice`, `PhoneState` to the rest of the system?**
  _29 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Bluetooth Call & PBAP` be split into smaller, more focused modules?**
  _Cohesion score 0.10752688172043011 - nodes in this community are weakly interconnected._
- **Should `Main Process Orchestration` be split into smaller, more focused modules?**
  _Cohesion score 0.10752688172043011 - nodes in this community are weakly interconnected._
- **Should `Bluetooth Media & Sync` be split into smaller, more focused modules?**
  _Cohesion score 0.1067193675889328 - nodes in this community are weakly interconnected._