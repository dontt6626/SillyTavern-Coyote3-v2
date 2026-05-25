# SillyTavern Coyote 3.0 Control v2

A SillyTavern extension for controlling your **DG-LAB Coyote 3.0** e-stim device via Web Bluetooth.

## Features

- **XToys-style volume control** — Per-channel volume sliders (0-100%) scale all output proportionally
- **Waveform presets** — Gentle, Pulse, Wave, Intense, Tease
- **AI-driven control** — AI emits XML-style tags that trigger your device in real time
- **Live stats** — Target, current, and battery level displayed in real time
- **Web Bluetooth** — Direct browser-to-device, no extra server needed

## Installation

1. In SillyTavern: **Extensions** → **Install Extension**
2. Paste: `https://github.com/dontt6626/SillyTavern-Coyote3-v2`
3. Restart SillyTavern

## Setup

1. Make sure your Coyote 3.0 is powered on and nearby
2. Use **Chrome or Edge** (Web Bluetooth is not supported in Firefox/Safari)
3. In SillyTavern: **Extensions** → **Coyote 3.0 v2**
4. Click **Pair Device** and select `47L121000` from the Bluetooth picker
5. Set your **Volume** (start around 30%)
6. Toggle **Enable AI Control**

## How It Works

The extension sends B0 frames every 100ms to the device. Output is controlled by:

1. **Target intensity** (0-200) — set by AI commands or test buttons
2. **Volume** (0-100%) — scales the waveform slot intensities proportionally
3. **Waveform preset** — defines the pulse pattern

### Volume

Unlike the old "Pain Threshold" ceiling, volume is a true multiplier:

- Volume = 100%, target = 100 → device receives full 100
- Volume = 30%, target = 100 → device receives 30 (scaled proportionally)
- Volume = 0% → no output regardless of target

This matches XToys' behavior where you set a comfortable base level and the content modulates within that range.

## AI Commands

```xml
<coyote3:a="50" time="5"/>     - Set Channel A to 50 for 5 seconds
<coyote3:b="30" time="3"/>     - Set Channel B to 30 for 3 seconds
<coyote3:stop/>                - Immediately stop both channels
<coyote3:clear channel="A"/>  - Clear Channel A
```

## Protocol Notes

This implementation follows the [DG-LAB V3 Bluetooth Protocol](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE/tree/main/coyote/v3) and the [DG-Kit](https://github.com/0xNullAI/DG-Kit) reference implementation.

Key differences from v1:
- Uses proper seq/ack handshake for B0 frames
- Slot intensities are 0-100 (protocol compliant)
- intBal defaults to 0 (matching official DG-Kit)
- Volume scales waveform slots, not strength bytes

## License

MIT License. Use responsibly.
