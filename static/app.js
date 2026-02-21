const WS_URL = `ws://${window.location.host}/ws`;
const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;

let websocket = null;
let mediaStream = null;
let audioContext = null;
let audioWorkletNode = null;
let isRecording = false;
let audioQueue = [];
let isPlayingAudio = false;

const startBtn = document.getElementById('start-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const conversationBox = document.getElementById('conversation');
const transcriptBox = document.getElementById('transcript');
const agentResponseBox = document.getElementById('agent-response');

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
            updateTranscript(event.text, false);
            break;

        case 'stt_output':
            updateTranscript(event.transcript, true);
            addUserMessage(event.transcript);
            break;

        case 'agent_chunk':
            appendAgentResponse(event.text);
            updateStatus('speaking', 'Agent responding...');
            break;

        case 'agent_end':
            updateStatus('listening', 'Listening...');
            const fullResponse = agentResponseBox.textContent;
            if (fullResponse && fullResponse !== 'Agent will respond here...') {
                addAssistantMessage(fullResponse);
                agentResponseBox.innerHTML = '<p class="placeholder">Agent will respond here...</p>';
            }
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

function updateTranscript(text, isFinal) {
    if (!text) return;
    
    const className = isFinal ? 'final-transcript' : 'partial-transcript';
    transcriptBox.innerHTML = `<p class="${className}">${escapeHtml(text)}</p>`;
}

function appendAgentResponse(text) {
    if (!text) return;
    
    const placeholder = agentResponseBox.querySelector('.placeholder');
    if (placeholder) {
        agentResponseBox.innerHTML = '';
    }
    
    const currentText = agentResponseBox.textContent || '';
    agentResponseBox.innerHTML = `<p class="agent-text">${escapeHtml(currentText + text)}</p>`;
}

function addUserMessage(text) {
    addMessage('user', '👤', text);
    transcriptBox.innerHTML = '<p class="placeholder">Your speech will appear here...</p>';
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
        const playbackContext = new AudioContext({ sampleRate: 44100 });
        const audioBuffer = await playbackContext.decodeAudioData(audioData.buffer);
        
        const source = playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackContext.destination);
        
        source.onended = () => {
            playbackContext.close();
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
