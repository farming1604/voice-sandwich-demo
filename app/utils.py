"""
Utility functions for the voice agent pipeline.

This module provides helper functions for working with async iterators
and other common operations across the voice agent system.
"""

import asyncio
import contextlib
from typing import Any, AsyncIterator, TypeVar


T = TypeVar("T")


async def merge_async_iters(*aiters: AsyncIterator[T]) -> AsyncIterator[T]:
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

    async def producer(aiter: AsyncIterator[Any]) -> None:
        try:
            async for item in aiter:
                await queue.put(("item", item))
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            await queue.put(("error", exc))
        finally:
            await queue.put(("done", None))

    tasks = [asyncio.create_task(producer(aiter)) for aiter in aiters]

    try:
        finished = 0
        while finished < len(aiters):
            kind, payload = await queue.get()
            if kind == "done":
                finished += 1
            elif kind == "error":
                raise payload
            else:
                yield payload
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        for aiter in aiters:
            aclose = getattr(aiter, "aclose", None)
            if aclose is not None:
                with contextlib.suppress(Exception):
                    await aclose()
