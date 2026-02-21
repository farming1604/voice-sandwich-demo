
import base64
import time
from enum import StrEnum
from pydantic import BaseModel, Field
from typing import Union


def _now_ms() -> int:
    return int(time.time() * 1000)


class EventType(StrEnum):
    USER_INPUT = "user_input"
    STT_CHUNK = "stt_chunk"
    STT_OUTPUT = "stt_output"
    AGENT_CHUNK = "agent_chunk"
    AGENT_END = "agent_end"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    TTS_CHUNK = "tts_chunk"


class UserInputEvent(BaseModel):
    type: EventType = Field(default=EventType.USER_INPUT)
    audio: bytes
    ts: int = Field(default_factory=_now_ms)

    @classmethod
    def create(cls, audio: bytes) -> "UserInputEvent":
        return cls(type=EventType.USER_INPUT, audio=audio, ts=_now_ms())


class STTChunkEvent(BaseModel):
    type: EventType = Field(default=EventType.STT_CHUNK)
    transcript: str
    ts: int = Field(default_factory=_now_ms)

    @classmethod
    def create(cls, transcript: str) -> "STTChunkEvent":
        return cls(type=EventType.STT_CHUNK, transcript=transcript, ts=_now_ms())


class STTOutputEvent(BaseModel):
    type: EventType = Field(default=EventType.STT_OUTPUT)
    transcript: str
    ts: int = Field(default_factory=_now_ms)

    @classmethod
    def create(cls, transcript: str) -> "STTOutputEvent":
        return cls(type=EventType.STT_OUTPUT, transcript=transcript, ts=_now_ms())


STTEvent = Union[STTChunkEvent, STTOutputEvent]


class AgentChunkEvent(BaseModel):
    type: EventType = Field(default=EventType.AGENT_CHUNK)
    text: str
    ts: int = Field(default_factory=_now_ms)

    @classmethod
    def create(cls, text: str) -> "AgentChunkEvent":
        return cls(type=EventType.AGENT_CHUNK, text=text, ts=_now_ms())


class AgentEndEvent(BaseModel):
    type: EventType = Field(default=EventType.AGENT_END)
    ts: int = Field(default_factory=_now_ms)

    @classmethod
    def create(cls) -> "AgentEndEvent":
        return cls(type=EventType.AGENT_END, ts=_now_ms())


class ToolCallEvent(BaseModel):
    type: EventType = Field(default=EventType.TOOL_CALL)
    id: str
    name: str
    args: dict
    ts: int = Field(default_factory=_now_ms)

    @classmethod
    def create(cls, id: str, name: str, args: dict) -> "ToolCallEvent":
        return cls(type=EventType.TOOL_CALL, id=id, name=name, args=args, ts=_now_ms())


class ToolResultEvent(BaseModel):
    type: EventType = Field(default=EventType.TOOL_RESULT)
    tool_call_id: str
    name: str
    result: str
    ts: int = Field(default_factory=_now_ms)

    @classmethod
    def create(cls, tool_call_id: str, name: str, result: str) -> "ToolResultEvent":
        return cls(
            type=EventType.TOOL_RESULT,
            tool_call_id=tool_call_id,
            name=name,
            result=result,
            ts=_now_ms(),
        )


AgentEvent = Union[AgentChunkEvent, AgentEndEvent, ToolCallEvent, ToolResultEvent]



class TTSChunkEvent(BaseModel):
    type: EventType = Field(default=EventType.TTS_CHUNK)
    audio: bytes
    ts: int = Field(default_factory=_now_ms)

    @classmethod
    def create(cls, audio: bytes) -> "TTSChunkEvent":
        return cls(type=EventType.TTS_CHUNK, audio=audio, ts=_now_ms())


VoiceAgentEvent = Union[UserInputEvent, STTEvent, AgentEvent, TTSChunkEvent]


def event_to_dict(event: VoiceAgentEvent) -> dict:
    if isinstance(event, UserInputEvent):
        return {"type": event.type.value, "ts": event.ts}
    elif isinstance(event, STTChunkEvent):
        return {"type": event.type.value, "transcript": event.transcript, "ts": event.ts}
    elif isinstance(event, STTOutputEvent):
        return {"type": event.type.value, "transcript": event.transcript, "ts": event.ts}
    elif isinstance(event, AgentChunkEvent):
        return {"type": event.type.value, "text": event.text, "ts": event.ts}
    elif isinstance(event, AgentEndEvent):
        return {"type": event.type.value, "ts": event.ts}
    elif isinstance(event, ToolCallEvent):
        return {
            "type": event.type.value,
            "id": event.id,
            "name": event.name,
            "args": event.args,
            "ts": event.ts,
        }
    elif isinstance(event, ToolResultEvent):
        return {
            "type": event.type.value,
            "toolCallId": event.tool_call_id,
            "name": event.name,
            "result": event.result,
            "ts": event.ts,
        }
    elif isinstance(event, TTSChunkEvent):
        return {
            "type": event.type.value,
            "audio": base64.b64encode(event.audio).decode("ascii"),
            "ts": event.ts,
        }
    else:
        raise ValueError(f"Unknown event type: {type(event)}")
