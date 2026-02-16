#!/usr/bin/env python3
"""
Fraktalia Port Forwarder — forwards host ports to Mox sandbox container.

Resolves the container IP dynamically per-connection so it survives
container recreation by OpenClaw.

Port range: 9000-9099 reserved for Fraktalia/Mox services.

Usage:
    python3 mox-port-forward.py [PORT...]
    python3 mox-port-forward.py 9000          # forward host:9000 → container:9000
    python3 mox-port-forward.py 9000 9001     # forward multiple ports
"""

import asyncio
import json
import logging
import os
import subprocess
import sys

CONTAINER_PREFIX = "openclaw-sbx-agent-mox-"
DEFAULT_PORTS = [9000]
BUF_SIZE = 65536

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("mox-fwd")


def resolve_container_ip() -> str | None:
    """Resolve the current Mox container IP via docker inspect."""
    try:
        out = subprocess.check_output(
            ["docker", "ps", "-q", "-f", f"name={CONTAINER_PREFIX}"],
            text=True,
            timeout=5,
        ).strip()
        if not out:
            return None
        container_id = out.splitlines()[0]
        info = subprocess.check_output(
            ["docker", "inspect", container_id],
            text=True,
            timeout=5,
        )
        data = json.loads(info)
        networks = data[0].get("NetworkSettings", {}).get("Networks", {})
        for net in networks.values():
            ip = net.get("IPAddress")
            if ip:
                return ip
    except Exception as e:
        log.debug(f"resolve_container_ip error: {e}")
    return None


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    """Copy data from reader to writer until EOF."""
    try:
        while True:
            data = await reader.read(BUF_SIZE)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def handle_connection(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    port: int,
):
    peer = client_writer.get_extra_info("peername")
    ip = resolve_container_ip()
    if not ip:
        log.warning(f"[:{port}] {peer} → no Mox container running, refusing")
        client_writer.close()
        return

    log.info(f"[:{port}] {peer} → {ip}:{port}")
    try:
        upstream_reader, upstream_writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=5
        )
    except Exception as e:
        log.warning(f"[:{port}] {peer} → connect to {ip}:{port} failed: {e}")
        client_writer.close()
        return

    await asyncio.gather(
        pipe(client_reader, upstream_writer),
        pipe(upstream_reader, client_writer),
    )
    log.info(f"[:{port}] {peer} closed")


async def start_forwarder(port: int):
    server = await asyncio.start_server(
        lambda r, w: handle_connection(r, w, port),
        host="0.0.0.0",
        port=port,
    )
    log.info(f"Forwarding 0.0.0.0:{port} → mox-container:{port}")
    async with server:
        await server.serve_forever()


async def main(ports: list[int]):
    log.info(f"Fraktalia Port Forwarder starting — ports: {ports}")
    ip = resolve_container_ip()
    if ip:
        log.info(f"Mox container found at {ip}")
    else:
        log.warning("No Mox container running (will resolve per-connection)")
    await asyncio.gather(*(start_forwarder(p) for p in ports))


if __name__ == "__main__":
    ports = [int(p) for p in sys.argv[1:]] if len(sys.argv) > 1 else DEFAULT_PORTS
    for p in ports:
        if not (9000 <= p <= 9099):
            log.error(f"Port {p} outside Fraktalia range 9000-9099, aborting")
            sys.exit(1)
    try:
        asyncio.run(main(ports))
    except KeyboardInterrupt:
        log.info("Shutting down")
