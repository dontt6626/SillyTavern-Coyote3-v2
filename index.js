import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    saveSettingsDebounced,
    setExtensionPrompt,
    getRequestHeaders,
} from '../../../../script.js';
import {
    extension_settings,
} from '../../../extensions.js';

const MODULE_NAME = 'coyote3v2';
const PROMPT_TAG = 'coyote3v2_control';

// --- DG-LAB V3 Bluetooth UUIDs ---
const BT_SERVICE_UUID = '0000180c-0000-1000-8000-00805f9b34fb';
const BT_WRITE_UUID   = '0000150a-0000-1000-8000-00805f9b34fb';
const BT_NOTIFY_UUID  = '0000150b-0000-1000-8000-00805f9b34fb';
const BT_BATTERY_SVC  = '0000180a-0000-1000-8000-00805f9b34fb';
const BT_BATTERY_CHAR = '00001500-0000-1000-8000-00805f9b34fb';
const BT_DEVICE_PREFIX = '47';

// --- Mode constants (bits 3-2 = A, bits 1-0 = B) ---
const MODE_NO_CHANGE = 0;
const MODE_REL_INC   = 1;
const MODE_REL_DEC   = 2;
const MODE_ABSOLUTE  = 3;

// --- Waveform presets ---
// Each slot: 4 freq bytes + 4 intensity bytes (8 hex chars each = 16 chars total)
// Frequency: 10-240. Intensity: 0-100.
const PRESETS = {
    gentle: [
        '0A0A0A0A00000000',
        '0A0A0A0A14141414',
        '0A0A0A0A28282828',
        '0A0A0A0A3C3C3C3C',
        '0A0A0A0A50505050',
        '0A0A0A0A3C3C3C3C',
        '0A0A0A0A28282828',
        '0A0A0A0A14141414',
    ],
    pulse: [
        '50505050FFFFFFFF',
        '50505050FFFFFFFF',
        '5050505000000000',
        '5050505000000000',
        '50505050FFFFFFFF',
        '50505050FFFFFFFF',
        '5050505000000000',
        '5050505000000000',
    ],
    wave: [
        '0A0A0A0A1E1E1E1E',
        '0A0A0A0A32323232',
        '0A0A0A0A46464646',
        '0A0A0A0A5A5A5A5A',
        '0A0A0A0A6E6E6E6E',
        '0A0A0A0A5A5A5A5A',
        '0A0A0A0A46464646',
        '0A0A0A0A32323232',
    ],
    intense: [
        '50505050FFFFFFFF',
        '50505050FFFFFFFF',
        '50505050FFFFFFFF',
        '50505050FFFFFFFF',
        '50505050FFFFFFFF',
        '50505050FFFFFFFF',
        '50505050FFFFFFFF',
        '50505050FFFFFFFF',
    ],
    tease: [
        '282828281E1E1E1E',
        '282828283C3C3C3C',
        '282828280A0A0A0A',
        '2828282850505050',
        '282828280A0A0A0A',
        '282828283C3C3C3C',
        '282828281E1E1E1E',
        '282828280A0A0A0A',
    ],
};

const defaultSettings = {
    enabled: false,
    connected: false,
    paired: false,
    volumeA: 100,
    volumeB: 100,
    limitA: 200,
    limitB: 200,
    freqBalA: 160,
    freqBalB: 160,
    intBalA: 0,
    intBalB: 0,
    waveformA: 'gentle',
    waveformB: 'gentle',
    guidelines: 'Match intensity to context. Use commands that fit the scene naturally.',
};

// --- Bluetooth state ---
let btDevice = null;
let btServer = null;
let btWriteChar = null;
let btNotifyChar = null;
let btBatteryChar = null;
let b0Timer = null;
let bluetoothConnected = false;

// --- Protocol state ---
let seq = 0;
let pendingMode = 0;
let awaitingAck = false;
let targetA = 0;       // ramp destination
let targetB = 0;
let currentA = 0;      // echoed from B1 feedback
let currentB = 0;
let batteryLevel = null;

// --- Ramping state ---
let rampCurrentA = 0;  // smoothed output value (0-200)
let rampCurrentB = 0;
let rampTimer = null;
const RAMP_STEP = 2;   // units per 50ms tick

// --- Runtime waveform presets (AI can override settings) ---
let activePresetA = null;  // null = use settings.waveformA
let activePresetB = null;  // null = use settings.waveformB

// --- AI command state ---
let streamingText = '';
let messageCommands = [];
let executedCommands = new Set();
let loopTimer = null;
let isLooping = false;

// --- Helpers ---
function hexToBytes(hex) {
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) {
        bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    return bytes;
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function startRamping() {
    if (rampTimer) return;
    rampTimer = setInterval(() => {
        // A channel
        const diffA = targetA - rampCurrentA;
        if (Math.abs(diffA) <= RAMP_STEP) {
            rampCurrentA = targetA;
        } else {
            rampCurrentA += diffA > 0 ? RAMP_STEP : -RAMP_STEP;
        }
        // B channel
        const diffB = targetB - rampCurrentB;
        if (Math.abs(diffB) <= RAMP_STEP) {
            rampCurrentB = targetB;
        } else {
            rampCurrentB += diffB > 0 ? RAMP_STEP : -RAMP_STEP;
        }
    }, 50);
}

function getWavePacketRaw(presetName) {
    const preset = PRESETS[presetName] || PRESETS.gentle;
    const idx = Math.floor(Date.now() / 100) % preset.length;
    const hex = preset[idx];
    const bytes = hexToBytes(hex);
    if (bytes.length !== 8) return { freq: [10,10,10,10], int: [0,0,0,0] };
    return {
        freq: bytes.slice(0, 4),
        int: bytes.slice(4, 8),
    };
}

// --- Web Bluetooth ---

async function connectBluetooth() {
    if (!navigator.bluetooth) {
        toastr.error('Web Bluetooth not supported. Use Chrome or Edge.');
        return false;
    }

    try {
        toastr.info('Scanning for Coyote 3.0...');
        btDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: BT_DEVICE_PREFIX }],
            optionalServices: [BT_SERVICE_UUID, BT_BATTERY_SVC],
        });

        btDevice.addEventListener('gattserverdisconnected', onDisconnected);

        btServer = await btDevice.gatt.connect();
        const service = await btServer.getPrimaryService(BT_SERVICE_UUID);
        btWriteChar = await service.getCharacteristic(BT_WRITE_UUID);
        btNotifyChar = await service.getCharacteristic(BT_NOTIFY_UUID);

        await btNotifyChar.startNotifications();
        btNotifyChar.addEventListener('characteristicvaluechanged', onNotify);

        try {
            const batterySvc = await btServer.getPrimaryService(BT_BATTERY_SVC);
            btBatteryChar = await batterySvc.getCharacteristic(BT_BATTERY_CHAR);
            const val = await btBatteryChar.readValue();
            batteryLevel = val.getUint8(0);
        } catch (e) {
            console.log('[Coyote3v2] Battery service not available');
            btBatteryChar = null;
            batteryLevel = null;
        }

        bluetoothConnected = true;
        extension_settings[MODULE_NAME].connected = true;
        extension_settings[MODULE_NAME].paired = true;
        saveSettingsDebounced();

        // Send BF to set limits and balances
        await sendBF();

        // Start B0 loop
        if (b0Timer) clearInterval(b0Timer);
        b0Timer = setInterval(sendB0, 100);

        updateStatus();
        toastr.success('Coyote 3.0 paired!');
        return true;
    } catch (error) {
        console.error('[Coyote3v2] Bluetooth error:', error);
        toastr.error(`Bluetooth failed: ${error.message}`);
        return false;
    }
}

function onDisconnected() {
    console.log('[Coyote3v2] Bluetooth disconnected');
    bluetoothConnected = false;
    btDevice = null;
    btServer = null;
    btWriteChar = null;
    btNotifyChar = null;
    btBatteryChar = null;
    if (b0Timer) { clearInterval(b0Timer); b0Timer = null; }
    targetA = 0; targetB = 0;
    rampCurrentA = 0; rampCurrentB = 0;
    activePresetA = null; activePresetB = null;
    currentA = 0; currentB = 0;
    awaitingAck = false; pendingMode = 0;
    extension_settings[MODULE_NAME].connected = false;
    extension_settings[MODULE_NAME].paired = false;
    saveSettingsDebounced();
    updateStatus();
}

function onNotify(event) {
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer);
    if (bytes[0] === 0xB1 && bytes.length >= 4) {
        const echoSeq = bytes[1];
        currentA = bytes[2];
        currentB = bytes[3];
        if (awaitingAck && (echoSeq & 0x0F) === (seq & 0x0F)) {
            awaitingAck = false;
            pendingMode = 0;
        }
        updateStatus();
        console.log('[Coyote3v2] B1 feedback: seq=', echoSeq, 'A=', currentA, 'B=', currentB);
    }
}

async function sendBF() {
    if (!btWriteChar) return;
    const s = extension_settings[MODULE_NAME];
    const buf = new Uint8Array(7);
    buf[0] = 0xBF;
    buf[1] = clamp(s.limitA ?? 200, 0, 200);
    buf[2] = clamp(s.limitB ?? 200, 0, 200);
    buf[3] = clamp(s.freqBalA ?? 160, 0, 255);
    buf[4] = clamp(s.freqBalB ?? 160, 0, 255);
    buf[5] = clamp(s.intBalA ?? 0, 0, 255);
    buf[6] = clamp(s.intBalB ?? 0, 0, 255);
    try {
        await btWriteChar.writeValue(buf);
        console.log('[Coyote3v2] BF sent:', Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' '));
    } catch (e) {
        console.error('[Coyote3v2] BF write error:', e);
    }
}

function nextSeq() {
    seq = (seq % 15) + 1;
    return seq;
}

async function sendB0() {
    if (!btWriteChar) return;

    const s = extension_settings[MODULE_NAME];
    const volA = (s.volumeA ?? 100) / 100;
    const volB = (s.volumeB ?? 100) / 100;

    // Use AI-selected preset if active, otherwise fall back to settings
    const presetA = activePresetA || s.waveformA || 'gentle';
    const presetB = activePresetB || s.waveformB || 'gentle';
    const packetA = getWavePacketRaw(presetA);
    const packetB = getWavePacketRaw(presetB);

    const scaleA = (rampCurrentA / 200) * volA;
    const scaleB = (rampCurrentB / 200) * volB;

    const aInts = packetA.int.map(v => clamp(Math.round(v * scaleA), 0, 100));
    const bInts = packetB.int.map(v => clamp(Math.round(v * scaleB), 0, 100));

    // Build B0 frame
    const buf = new Uint8Array(20);
    buf[0] = 0xB0;

    // Mode: both channels absolute
    const modeCombined = (MODE_ABSOLUTE << 2) | MODE_ABSOLUTE; // 0x0F

    // Use rampCurrent for strength bytes so the device sees the smoothed value
    if (!awaitingAck && (rampCurrentA !== currentA || rampCurrentB !== currentB)) {
        seq = nextSeq();
        pendingMode = modeCombined;
        awaitingAck = true;
    } else if (awaitingAck) {
        pendingMode = 0; // no change until ack
    }

    buf[1] = ((seq & 0x0F) << 4) | (pendingMode & 0x0F);
    buf[2] = clamp(Math.round(rampCurrentA), 0, 200);
    buf[3] = clamp(Math.round(rampCurrentB), 0, 200);

    buf.set(packetA.freq, 4);
    buf.set(aInts, 8);
    buf.set(packetB.freq, 12);
    buf.set(bInts, 16);

    try {
        await btWriteChar.writeValue(buf);
    } catch (e) {
        console.error('[Coyote3v2] B0 write error:', e);
    }
}

function disconnectBluetooth() {
    if (btServer && btServer.connected) btServer.disconnect();
    onDisconnected();
}

// --- AI Command Parsing ---

function parseCommands(text) {
    const regex = /<coyote3:(\w+)([^\/]*?)\/>/gi;
    const commands = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const action = match[1].toLowerCase();
        const attrs = {};
        const attrRegex = /(\w+)="([^"]+)"/g;
        let am;
        while ((am = attrRegex.exec(match[2])) !== null) {
            attrs[am[1].toLowerCase()] = am[2];
        }

        if (action === 'stop') {
            commands.push({ type: 'stop' });
            continue;
        }
        if (action === 'clear') {
            commands.push({ type: 'clear', channel: (attrs.channel || 'A').toUpperCase() });
            continue;
        }
        if (['channela', 'a'].includes(action)) {
            const v = parseInt(attrs[action] || attrs.intensity || attrs.strength);
            const preset = attrs.preset || attrs.waveform || attrs.pattern;
            if (!isNaN(v)) {
                commands.push({ type: 'strength', channel: 'A', value: v, time: parseFloat(attrs.time || attrs.duration || 5), preset });
            }
            continue;
        }
        if (['channelb', 'b'].includes(action)) {
            const v = parseInt(attrs[action] || attrs.intensity || attrs.strength);
            const preset = attrs.preset || attrs.waveform || attrs.pattern;
            if (!isNaN(v)) {
                commands.push({ type: 'strength', channel: 'B', value: v, time: parseFloat(attrs.time || attrs.duration || 5), preset });
            }
            continue;
        }
        if (action === 'combo') {
            const actions = [];
            if (attrs.channela !== undefined) actions.push({ channel: 'A', value: parseInt(attrs.channela) });
            if (attrs.a !== undefined) actions.push({ channel: 'A', value: parseInt(attrs.a) });
            if (attrs.channelb !== undefined) actions.push({ channel: 'B', value: parseInt(attrs.channelb) });
            if (attrs.b !== undefined) actions.push({ channel: 'B', value: parseInt(attrs.b) });
            if (actions.length) commands.push({ type: 'combo', actions, time: parseFloat(attrs.time || attrs.duration || 5) });
            continue;
        }
    }
    return commands;
}

// --- Command Execution ---

function sendCommand(cmd) {
    const s = extension_settings[MODULE_NAME];
    if (!s.paired) return false;

    switch (cmd.type) {
        case 'strength': {
            if (cmd.channel === 'A') {
                targetA = clamp(cmd.value, 0, s.limitA || 200);
                if (cmd.preset && PRESETS[cmd.preset]) activePresetA = cmd.preset;
            } else {
                targetB = clamp(cmd.value, 0, s.limitB || 200);
                if (cmd.preset && PRESETS[cmd.preset]) activePresetB = cmd.preset;
            }
            return true;
        }
        case 'combo': {
            for (const act of cmd.actions || []) {
                const lim = act.channel === 'A' ? (s.limitA || 200) : (s.limitB || 200);
                if (act.channel === 'A') targetA = clamp(act.value, 0, lim);
                else targetB = clamp(act.value, 0, lim);
            }
            return true;
        }
        case 'stop':
            targetA = 0; targetB = 0;
            activePresetA = null;
            activePresetB = null;
            if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
            isLooping = false;
            return true;
        case 'clear':
            if (cmd.channel === 'A') targetA = 0;
            else targetB = 0;
            return true;
    }
    return false;
}

function startLoop() {
    if (loopTimer) clearTimeout(loopTimer);
    if (!messageCommands.length) return;
    isLooping = true;
    let idx = 0;
    const next = () => {
        if (!isLooping || !messageCommands.length) return;
        const cmd = messageCommands[idx % messageCommands.length];
        sendCommand(cmd);
        idx++;
        loopTimer = setTimeout(next, (cmd.timeSec || 5) * 1000);
    };
    next();
}

function stopLoop() {
    isLooping = false;
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
}

// --- Event Handlers ---

async function onStreamToken(data) {
    const s = extension_settings[MODULE_NAME];
    if (!s.enabled || !s.paired) return;
    const token = typeof data === 'string' ? data : (data?.text || data?.message || '');
    if (!token) return;
    streamingText += token;
    const cmds = parseCommands(streamingText);
    for (const cmd of cmds) {
        const key = JSON.stringify(cmd);
        if (!executedCommands.has(key)) {
            executedCommands.add(key);
            messageCommands.push(cmd);
            sendCommand(cmd);
        }
    }
}

async function onMessageReceived(data) {
    const s = extension_settings[MODULE_NAME];
    if (!s.enabled || !s.paired) return;
    const msgId = typeof data === 'number' ? data : data?.index;
    const ctx = SillyTavern.getContext();
    const msg = ctx.chat[msgId];
    if (!msg || msg.is_user) return;
    const cmds = parseCommands(msg.mes || '');
    if (!cmds.length) return;
    stopLoop();
    messageCommands = cmds;
    executedCommands.clear();
    startLoop();
}

function onGenerationStarted() {
    executedCommands.clear();
    messageCommands = [];
    streamingText = '';
}

function onGenerationEnded() {
    streamingText = '';
    stopLoop();
    startLoop();
}

// --- Prompt ---

function generatePrompt() {
    const s = extension_settings[MODULE_NAME];
    const volA = s.volumeA ?? 100;
    const volB = s.volumeB ?? 100;
    return `You can control the user's DG-LAB Coyote 3.0 device:
<coyote3>
Commands: <coyote3:a="X" time="Y"/> (A=0-${s.limitA || 200}), <coyote3:b="X" time="Y"/> (B=0-${s.limitB || 200})
Waveform presets: gentle, pulse, wave, intense, tease
You can pick a waveform per command: <coyote3:a="50" time="5" preset="intense"/>
Volume: A=${volA}%, B=${volB}%
<coyote3:stop/> to stop. <coyote3:clear channel="A"/> to clear.
Guidelines: ${s.guidelines || ''}
</coyote3>`;
}

function updatePrompt() {
    const s = extension_settings[MODULE_NAME];
    if (!s.enabled || !s.paired) {
        setExtensionPrompt(PROMPT_TAG, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }
    setExtensionPrompt(PROMPT_TAG, generatePrompt(), extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

// --- UI ---

function updateStatus() {
    const s = extension_settings[MODULE_NAME];
    const statusDiv = $('#c3v2_status');
    const statusText = $('#c3v2_status_text');

    if (bluetoothConnected) {
        statusDiv.removeClass('disconnected').addClass('connected');
        statusText.text('Paired');
    } else {
        statusDiv.removeClass('connected').addClass('disconnected');
        statusText.text('Not Connected');
    }

    $('#c3v2_targetA').text(targetA);
    $('#c3v2_targetB').text(targetB);
    $('#c3v2_currentA').text(Math.round(rampCurrentA));
    $('#c3v2_currentB').text(Math.round(rampCurrentB));
    $('#c3v2_battery').text(batteryLevel !== null ? batteryLevel + '%' : '--');

    const presetA = activePresetA || s.waveformA || 'gentle';
    const presetB = activePresetB || s.waveformB || 'gentle';
    $('#c3v2_preset_a').text(presetA);
    $('#c3v2_preset_b').text(presetB);
}

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][k] === undefined) {
            extension_settings[MODULE_NAME][k] = v;
        }
    }
    const s = extension_settings[MODULE_NAME];
    $('#c3v2_enabled').prop('checked', s.enabled);
    $('#c3v2_volume_a').val(s.volumeA ?? 100);
    $('#c3v2_volume_b').val(s.volumeB ?? 100);
    $('#c3v2_limit_a').val(s.limitA ?? 200);
    $('#c3v2_limit_b').val(s.limitB ?? 200);
    $('#c3v2_wave_a').val(s.waveformA || 'gentle');
    $('#c3v2_wave_b').val(s.waveformB || 'gentle');
    $('#c3v2_guidelines').val(s.guidelines || '');
    updateStatus();
    updatePrompt();
}

function setupUI() {
    $('#c3v2_enabled').on('change', function () {
        extension_settings[MODULE_NAME].enabled = $(this).prop('checked');
        saveSettingsDebounced();
        updatePrompt();
    });

    $('#c3v2_volume_a').on('input', function () {
        extension_settings[MODULE_NAME].volumeA = clamp(parseInt($(this).val()) || 100, 0, 100);
        saveSettingsDebounced();
        updateStatus();
    });

    $('#c3v2_volume_b').on('input', function () {
        extension_settings[MODULE_NAME].volumeB = clamp(parseInt($(this).val()) || 100, 0, 100);
        saveSettingsDebounced();
        updateStatus();
    });

    $('#c3v2_limit_a').on('input', function () {
        extension_settings[MODULE_NAME].limitA = clamp(parseInt($(this).val()) || 200, 0, 200);
        saveSettingsDebounced();
        if (bluetoothConnected) sendBF();
    });

    $('#c3v2_limit_b').on('input', function () {
        extension_settings[MODULE_NAME].limitB = clamp(parseInt($(this).val()) || 200, 0, 200);
        saveSettingsDebounced();
        if (bluetoothConnected) sendBF();
    });

    $('#c3v2_wave_a').on('change', function () {
        extension_settings[MODULE_NAME].waveformA = $(this).val();
        saveSettingsDebounced();
    });

    $('#c3v2_wave_b').on('change', function () {
        extension_settings[MODULE_NAME].waveformB = $(this).val();
        saveSettingsDebounced();
    });

    $('#c3v2_guidelines').on('input', function () {
        extension_settings[MODULE_NAME].guidelines = $(this).val();
        saveSettingsDebounced();
        updatePrompt();
    });

    $('#c3v2_pair').on('click', async function () {
        await connectBluetooth();
    });

    $('#c3v2_disconnect').on('click', function () {
        disconnectBluetooth();
    });

    // Test buttons
    $('.c3v2-test-a').on('click', async function () {
        const val = parseInt($(this).data('value'));
        targetA = val;
        updateStatus();
        toastr.info(`Channel A = ${val}`);
    });

    $('.c3v2-test-b').on('click', async function () {
        const val = parseInt($(this).data('value'));
        targetB = val;
        updateStatus();
        toastr.info(`Channel B = ${val}`);
    });

    $('#c3v2_stop').on('click', function () {
        targetA = 0; targetB = 0;
        stopLoop();
        updateStatus();
        toastr.success('Stopped');
    });
}

// --- Init ---

jQuery(async () => {
    const extensionPath = new URL('.', import.meta.url).pathname;
    const html = await fetch(`${extensionPath}settings.html`).then(r => r.text());
    $('#extensions_settings2').append(html);

    loadSettings();
    setupUI();
    startRamping();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.CHAT_CHANGED, updatePrompt);

    console.log('[Coyote3v2] Extension initialized');
});
