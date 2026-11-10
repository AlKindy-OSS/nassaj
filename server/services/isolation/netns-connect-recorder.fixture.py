"""Records every connection attempt inside a sealed network namespace.

ADR-227 / T-2098 qa item 4. Runs INSIDE `unshare -rn` after the namespace routed
every IPv4/IPv6 destination to loopback (`ip route add local default dev lo`), so
any connect or datagram the CLI makes (a DNS query, a TLS dial to a vendor host)
materialises as a packet on `lo` instead of failing before it is sent. Captures
with an AF_PACKET socket on `lo` and records each TCP SYN (without ACK) and each
UDP datagram as {proto, dst, port}, plus the looked-up name of a DNS query.
Other payloads are never stored.

usage: python3 -I netns-connect-recorder.fixture.py <out.json> <ready-file>
Writes <ready-file> once capturing; writes <out.json> on SIGTERM.
"""
import json
import signal
import socket
import struct
import sys

ETH_P_ALL = 0x0003
PACKET_OUTGOING = 4
OUT, READY = sys.argv[1], sys.argv[2]
attempts = []


def record(proto, dst, port, name=None):
    entry = {"proto": proto, "dst": dst, "port": port}
    if name is not None:
        entry["query"] = name
    attempts.append(entry)


def dns_question(payload):
    """The first QNAME of a DNS query (the name looked up, never an answer)."""
    labels, offset = [], 12
    try:
        while payload[offset]:
            length = payload[offset]
            labels.append(payload[offset + 1:offset + 1 + length].decode("ascii", "replace"))
            offset += 1 + length
    except IndexError:
        return "?"
    return ".".join(labels)


def parse(frame):
    ether_type = struct.unpack("!H", frame[12:14])[0]
    if ether_type == 0x0800:
        ihl = (frame[14] & 0x0F) * 4
        proto = frame[23]
        dst = socket.inet_ntop(socket.AF_INET, frame[30:34])
        transport = frame[14 + ihl:]
    elif ether_type == 0x86DD:
        proto = frame[20]
        dst = socket.inet_ntop(socket.AF_INET6, frame[38:54])
        transport = frame[54:]
    else:
        return
    if proto == 6 and len(transport) >= 14:
        flags = transport[13]
        if flags & 0x02 and not flags & 0x10:
            record("tcp", dst, struct.unpack("!H", transport[2:4])[0])
    elif proto == 17 and len(transport) >= 8:
        port = struct.unpack("!H", transport[2:4])[0]
        record("udp", dst, port, dns_question(transport[8:]) if port == 53 else None)


def finish(*_):
    with open(OUT, "w", encoding="utf8") as handle:
        json.dump({"attempts": attempts}, handle)
    sys.exit(0)


signal.signal(signal.SIGTERM, finish)
sniffer = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_P_ALL))
sniffer.bind(("lo", 0))
open(READY, "w", encoding="utf8").close()
while True:
    frame, address = sniffer.recvfrom(65535)
    if address[2] != PACKET_OUTGOING:
        parse(frame)
