const WS_URL = `ws://${window.location.host}/ws`;
const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
const TTS_SAMPLE_RATE = 24000;

let websocket = null;
let mediaStream = null;
let audioContext = null;
let audioWorkletNode = null;
let isRecording = false;
let audioQueue = [];
let isPlayingAudio = false;
let playbackContext = null;

const startBtn = document.getElementById('start-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const conversationBox = document.getElementById('conversation');
let liveTranscriptMessage = null;
let liveAssistantMessage = null;

startBtn.addEventListener('click', toggleRecording);

async function toggleRecording() {
    if (!isRecording) {
        await startRecording();
    } else {
        stopRecording();
    }
}

async function startRecording() {
    try {
        updateStatus('connecting', 'Connecting...');
        
        mediaStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                sampleRate: SAMPLE_RATE,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } 
        });

        audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        
        websocket = new WebSocket(WS_URL);
        setupWebSocketHandlers();

        await new Promise((resolve, reject) => {
            websocket.onopen = resolve;
            websocket.onerror = reject;
        });

        const source = audioContext.createMediaStreamSource(mediaStream);
        const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

        processor.onaudioprocess = (e) => {
            if (!isRecording || !websocket || websocket.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);
            const pcmData = convertFloat32ToInt16(inputData);
            
            websocket.send(pcmData);
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        audioWorkletNode = processor;

        isRecording = true;
        updateStatus('listening', 'Listening...');
        startBtn.innerHTML = '<span class="btn-icon">⏹️</span> Stop';
        startBtn.classList.remove('btn-primary');
        startBtn.classList.add('btn-danger');

        addSystemMessage('🎤 Recording started. Speak now!');

    } catch (error) {
        console.error('Error starting recording:', error);
        updateStatus('error', 'Error: ' + error.message);
        addSystemMessage('❌ Could not access microphone: ' + error.message);
        stopRecording();
    }
}

function stopRecording() {
    isRecording = false;

    if (websocket) {
        websocket.close();
        websocket = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    if (audioWorkletNode) {
        audioWorkletNode.disconnect();
        audioWorkletNode = null;
    }

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    if (playbackContext) {
        playbackContext.close();
        playbackContext = null;
    }

    audioQueue = [];
    isPlayingAudio = false;

    updateStatus('inactive', 'Stopped');
    startBtn.innerHTML = '<span class="btn-icon">🎤</span> Start Voice Chat';
    startBtn.classList.remove('btn-danger');
    startBtn.classList.add('btn-primary');

    addSystemMessage('⏹️ Recording stopped.');
}

function setupWebSocketHandlers() {
    websocket.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            handleEvent(data);
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };

    websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('error', 'Connection error');
        addSystemMessage('❌ WebSocket connection error');
    };

    websocket.onclose = () => {
        console.log('WebSocket closed');
        if (isRecording) {
            stopRecording();
        }
    };
}

function handleEvent(event) {
    console.log('Event received:', event.type, event);

    switch (event.type) {
        case 'stt_chunk':
            upsertLiveTranscript(event.transcript);
            break;

        case 'stt_output':
            finalizeLiveTranscript(event.transcript);
            break;

        case 'agent_chunk':
            appendLiveAssistantResponse(event.text);
            updateStatus('speaking', 'Agent responding...');
            break;

        case 'agent_end':
            updateStatus('listening', 'Listening...');
            finalizeLiveAssistantResponse();
            break;

        case 'tool_call':
            addToolMessage(`🔧 Calling tool: ${event.name}`, event.args);
            break;

        case 'tool_result':
            addToolMessage(`✅ Result: ${event.name}`, event.result);
            break;

        case 'tts_chunk':
            if (event.audio) {
                playAudioChunk(event.audio);
            }
            break;

        default:
            console.log('Unknown event type:', event.type);
    }
}

function updateStatus(status, text) {
    statusDot.className = `status-dot ${status}`;
    statusText.textContent = text;
}

function upsertLiveTranscript(text) {
    if (!text) return;

    if (!liveTranscriptMessage) {
        liveTranscriptMessage = createLiveMessage('user', '👤');
    }

    liveTranscriptMessage.textContent = text;
    conversationBox.scrollTop = conversationBox.scrollHeight;
}

function finalizeLiveTranscript(text) {
    if (!text) return;

    if (liveTranscriptMessage) {
        const liveNode = liveTranscriptMessage.closest('.message');
        if (liveNode) {
            liveNode.remove();
        }
        liveTranscriptMessage = null;
    }

    addUserMessage(text);
}

function appendLiveAssistantResponse(text) {
    if (!text) return;

    if (!liveAssistantMessage) {
        liveAssistantMessage = createLiveMessage('assistant', '🤖');
    }

    liveAssistantMessage.textContent += text;
    conversationBox.scrollTop = conversationBox.scrollHeight;
}

function finalizeLiveAssistantResponse() {
    if (!liveAssistantMessage) return;
    liveAssistantMessage = null;
}

function addUserMessage(text) {
    addMessage('user', '👤', text);
}

function addAssistantMessage(text) {
    addMessage('assistant', '🤖', text);
}

function addSystemMessage(text) {
    addMessage('system', 'ℹ️', text);
}

function addToolMessage(title, content) {
    const contentStr = typeof content === 'object' ? JSON.stringify(content, null, 2) : content;
    addMessage('tool', '🔧', `${title}\n${contentStr}`);
}

function createLiveMessage(type, icon) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'message-icon';
    iconSpan.textContent = icon;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    messageDiv.appendChild(iconSpan);
    messageDiv.appendChild(contentDiv);
    conversationBox.appendChild(messageDiv);

    return contentDiv;
}

function addMessage(type, icon, text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    messageDiv.innerHTML = `
        <span class="message-icon">${icon}</span>
        <div class="message-content">${escapeHtml(text)}</div>
    `;
    conversationBox.appendChild(messageDiv);
    
    conversationBox.scrollTop = conversationBox.scrollHeight;
}

function playAudioChunk(base64Audio) {
    try {
        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        audioQueue.push(bytes);
        
        if (!isPlayingAudio) {
            playNextAudioChunk();
        }
    } catch (error) {
        console.error('Error playing audio chunk:', error);
    }
}

async function playNextAudioChunk() {
    if (audioQueue.length === 0) {
        isPlayingAudio = false;
        return;
    }

    isPlayingAudio = true;
    const audioData = audioQueue.shift();

    try {
        if (!playbackContext) {
            playbackContext = new AudioContext();
        }

        if (playbackContext.state === 'suspended') {
            await playbackContext.resume();
        }

        const sampleCount = Math.floor(audioData.byteLength / 2);
        const pcm16 = new Int16Array(
            audioData.buffer,
            audioData.byteOffset,
            sampleCount
        );
        const pcmFloat = new Float32Array(sampleCount);

        for (let i = 0; i < sampleCount; i++) {
            pcmFloat[i] = Math.max(-1, Math.min(1, pcm16[i] / 32768));
        }

        const audioBuffer = playbackContext.createBuffer(
            1,
            pcmFloat.length,
            TTS_SAMPLE_RATE
        );
        audioBuffer.copyToChannel(pcmFloat, 0);

        const source = playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackContext.destination);
        
        source.onended = () => {
            playNextAudioChunk();
        };
        
        source.start();
    } catch (error) {
        console.error('Error decoding/playing audio:', error);
        playNextAudioChunk();
    }
}

function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array.buffer;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

window.addEventListener('beforeunload', () => {
    if (isRecording) {
        stopRecording();
    }
});