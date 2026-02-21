import asyncio
import contextlib
from pathlib import Path
from typing import AsyncGenerator, AsyncIterator
from uuid import uuid4

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent
from langchain.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableGenerator
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph.state import CompiledStateGraph
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.assemblyai_stt import AssemblyAISTT
from app.cartesia_tts import CartesiaTTS
from app.events import (
    AgentChunkEvent,
    AgentEndEvent,
    EventType,
    ToolCallEvent,
    ToolResultEvent,
    VoiceAgentEvent,
    event_to_dict,
)
from app.utils import merge_async_iters
from app.config import settings

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
app.mount("/.well-known", StaticFiles(directory=str(static_dir / ".well-known")), name="well-known")


def add_to_order(item: str, quantity: int) -> str:
    """Add a requested item and quantity to the current order."""
    return f"Added {quantity} x {item} to the order."


def confirm_order(order_summary: str) -> str:
    """Confirm the order summary and send it to the kitchen."""
    return f"Order confirmed: {order_summary}. Sending to kitchen."


system_prompt = """
You are a helpful sandwich shop assistant. Your goal is to take the user's order.
Be concise and friendly.

Available toppings: lettuce, tomato, onion, pickles, mayo, mustard.
Available meats: turkey, ham, roast beef.
Available cheeses: swiss, cheddar, provolone.

${CARTESIA_TTS_SYSTEM_PROMPT}
"""

model = ChatOpenAI(
    model=settings.GEMINI_DEFAULT_MODEL,
    api_key=settings.GEMINI_API_KEY,
    base_url=settings.GEMINI_BASE_URL,
)

agent: CompiledStateGraph = create_agent(
    model=model,
    tools=[add_to_order, confirm_order],
    system_prompt=system_prompt,
    checkpointer=InMemorySaver(),
)

def _make_stt_stream():
    async def _stt_stream(audio_stream: AsyncIterator[bytes]) -> AsyncIterator[VoiceAgentEvent]:
        stt = AssemblyAISTT(sample_rate=16000)

        async def _send_audio():
            try:
                async for audio_chunk in audio_stream:
                    await stt.send_audio(audio_chunk)
            finally:
                await stt.close()

        send_task = asyncio.create_task(_send_audio())

        try:
            async for event in stt.receive_events():
                yield event
        finally:
            with contextlib.suppress(asyncio.CancelledError):
                send_task.cancel()
                await send_task
            await stt.close()

    return _stt_stream


def _make_agent_stream(agent: CompiledStateGraph):
    async def _agent_stream(event_stream: AsyncIterator[VoiceAgentEvent]) -> AsyncIterator[VoiceAgentEvent]:
        thread_id = str(uuid4())

        async for event in event_stream:
            yield event

            if event.type == EventType.STT_OUTPUT:
                stream = agent.astream(
                    {"messages": [HumanMessage(content=event.transcript)]},
                    {"configurable": {"thread_id": thread_id}},
                    stream_mode="messages",
                )

                async for message, metadata in stream:
                    if isinstance(message, (AIMessage, AIMessageChunk)):
                        chunk_text = message.text if hasattr(message, "text") else ""
                        if not chunk_text and isinstance(message.content, str):
                            chunk_text = message.content

                        if chunk_text:
                            yield AgentChunkEvent.create(chunk_text)
                        if hasattr(message, "tool_calls") and message.tool_calls:
                            for tool_call in message.tool_calls:
                                yield ToolCallEvent.create(
                                    id=tool_call.get("id", str(uuid4())),
                                    name=tool_call.get("name", "unknown"),
                                    args=tool_call.get("args", {}),
                                )

                    if isinstance(message, ToolMessage):
                        yield ToolResultEvent.create(
                            tool_call_id=getattr(message, "tool_call_id", ""),
                            name=getattr(message, "name", "unknown"),
                            result=str(message.content) if message.content else "",
                        )

                yield AgentEndEvent.create()

    return _agent_stream


def _make_tts_stream():
    async def _tts_stream(event_stream: AsyncIterator[VoiceAgentEvent]) -> AsyncIterator[VoiceAgentEvent]:
        tts = CartesiaTTS()

        async def _process_upstream() -> AsyncIterator[VoiceAgentEvent]:
            buffer: list[str] = []
            async for event in event_stream:
                yield event
                if event.type == EventType.AGENT_CHUNK:
                    buffer.append(event.text)
                if event.type == EventType.AGENT_END:
                    await tts.send_text("".join(buffer))
                    buffer = []

        try:
            async for event in merge_async_iters(_process_upstream(), tts.receive_events()):
                yield event
        finally:
            await tts.close()

    return _tts_stream


_stt = _make_stt_stream()
_agent = _make_agent_stream(agent)
_tts = _make_tts_stream()

pipeline = RunnableGenerator(_stt) | RunnableGenerator(_agent) | RunnableGenerator(_tts)


@app.get("/")
async def read_root():
    return FileResponse(str(Path(__file__).parent / "static" / "index.html"))


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    async def websocket_audio_stream() -> AsyncIterator[bytes]:
        while True:
            try:
                data = await websocket.receive_bytes()
            except WebSocketDisconnect:
                break
            yield data

    output_stream: AsyncGenerator[VoiceAgentEvent, None] = pipeline.atransform(websocket_audio_stream())

    try:
        async for event in output_stream:
            if websocket.client_state != WebSocketState.CONNECTED:
                break
            await websocket.send_json(event_to_dict(event))
    except WebSocketDisconnect:
        pass
    except RuntimeError as exc:
        if "Unexpected ASGI message 'websocket.send'" not in str(exc):
            raise
    finally:
        with contextlib.suppress(Exception):
            await output_stream.aclose()
            if websocket.application_state != WebSocketState.DISCONNECTED:
                await websocket.close()


if __name__ == "__main__":
    uvicorn.run("main:app", port=8000, reload=True)
