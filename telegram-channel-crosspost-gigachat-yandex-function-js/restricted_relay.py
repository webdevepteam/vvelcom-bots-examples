#!/usr/bin/env python3
"""
Restricted outbound HTTPS relay.

Takes an authorized JSON request, makes an outgoing HTTPS request only to allowed
domains and returns the status and the response text. Use it where direct access
to a site (for example t.me) is closed: install the relay on a server that has
access, and let the client go through it.

Production run: Gunicorn (`restricted_relay:app`), see simple-relay.service.
"""
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import logging
import os
import socket
import ssl
import sys
import threading
import time
import uuid
from collections import deque
from logging.handlers import WatchedFileHandler
from urllib.parse import urlparse

from flask import Flask, jsonify, request


APP_VERSION = "2026.10.05.011"

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "9010"))

RELAY_SERVICE_TOKEN = os.environ.get("RELAY_SERVICE_TOKEN", "")

ALLOWED_HOSTS = {
    item.strip().lower().rstrip(".")
    for item in os.environ.get("ALLOWED_HOSTS", "").split(",")
    if item.strip()
}

MAX_BODY_BYTES = 64 * 1024
MAX_UPSTREAM_RESPONSE_BYTES = 256 * 1024
# For binary files (photos) in responseEncoding=base64 mode.
MAX_UPSTREAM_BINARY_BYTES = 8 * 1024 * 1024
UPSTREAM_TIMEOUT_SECONDS = 20
READ_CHUNK_BYTES = 8192

RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_REQUESTS = 60

ALLOWED_METHODS = {"GET", "POST"}

ALLOWED_REQUEST_HEADERS = {
    "accept",
    "content-type",
    "user-agent",
}

SCRIPT_PATH = os.path.abspath(__file__)
BASE_DIR = os.path.dirname(SCRIPT_PATH)
LOG_FILE = os.environ.get("LOG_FILE", os.path.join(BASE_DIR, "relay.log"))

with open(SCRIPT_PATH, "rb") as source_file:
    APP_SHA256 = hashlib.sha256(source_file.read()).hexdigest()[:12]

if len(RELAY_SERVICE_TOKEN) < 16 or RELAY_SERVICE_TOKEN.startswith("CHANGE_ME"):
    raise RuntimeError(
        "RELAY_SERVICE_TOKEN is required: at least 16 characters, not the example value",
    )

if not ALLOWED_HOSTS:
    raise RuntimeError("ALLOWED_HOSTS must contain at least one hostname")


logger = logging.getLogger("restricted-relay")
logger.setLevel(logging.INFO)
logger.propagate = False

if not logger.handlers:
    try:
        log_handler = WatchedFileHandler(LOG_FILE, encoding="utf-8")
    except OSError:
        # Log file is not writable: write to stderr (it ends up in journalctl).
        log_handler = logging.StreamHandler(sys.stderr)

    log_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(message)s"),
    )
    logger.addHandler(log_handler)


def log(event, **fields):
    logger.info(
        json.dumps(
            {"event": event, **fields},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


def log_startup(event):
    log(
        event,
        appVersion=APP_VERSION,
        appPath=SCRIPT_PATH,
        appSha256=APP_SHA256,
        appMtime=int(os.path.getmtime(SCRIPT_PATH)),
        pythonExecutable=sys.executable,
        pythonVersion=sys.version.split()[0],
        host=HOST,
        port=PORT,
        allowedHosts=sorted(ALLOWED_HOSTS),
    )


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES

# Gunicorn imports the module and `__main__` does not run, so log on import.
log_startup("relay_module_loaded")


def json_response(status, **body):
    response = jsonify(body)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def safe_equal(left, right):
    left_bytes = (left or "").encode("utf-8")
    right_bytes = (right or "").encode("utf-8")

    return (
        len(left_bytes) == len(right_bytes)
        and hmac.compare_digest(left_bytes, right_bytes)
    )


# In-memory rate limit: enough for a single Gunicorn worker.
rate_buckets = {}
rate_lock = threading.Lock()


def rate_limit_allowed(client_ip):
    now = time.monotonic()

    with rate_lock:
        bucket = rate_buckets.setdefault(client_ip, deque())

        while bucket and now - bucket[0] >= RATE_LIMIT_WINDOW_SECONDS:
            bucket.popleft()

        if len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
            return False

        bucket.append(now)

        # Drop empty keys so the dict does not grow forever.
        if len(rate_buckets) > 1024:
            for key in [k for k, v in rate_buckets.items() if not v]:
                del rate_buckets[key]

    return True


def is_allowed_host(hostname):
    hostname = hostname.lower().rstrip(".")

    return any(
        hostname == allowed or hostname.endswith("." + allowed)
        for allowed in ALLOWED_HOSTS
    )


def is_public_ip(address):
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False

    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or ip.is_reserved
    )


def validate_target_url(raw_url):
    """Returns (parsed, hostname, list of public IPs) or raises ValueError."""
    if not isinstance(raw_url, str) or len(raw_url) > 2048:
        raise ValueError("url must be a string up to 2048 characters")

    parsed = urlparse(raw_url)

    if parsed.scheme != "https":
        raise ValueError("only https:// URLs are allowed")

    if not parsed.hostname:
        raise ValueError("URL must include hostname")

    if parsed.username or parsed.password or "@" in parsed.netloc:
        raise ValueError("credentials in URL are not allowed")

    if parsed.fragment or "#" in raw_url:
        raise ValueError("URL fragments are not allowed")

    hostname = parsed.hostname.lower().rstrip(".")

    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise ValueError("IP addresses in URL are not allowed")

    if not is_allowed_host(hostname):
        raise ValueError("host is not in ALLOWED_HOSTS")

    try:
        port = parsed.port or 443
    except ValueError as error:
        raise ValueError("invalid port in URL") from error

    if port != 443:
        raise ValueError("only HTTPS port 443 is allowed")

    try:
        addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise ValueError(f"DNS lookup failed: {error}") from error

    resolved_ips = {
        entry[4][0]
        for entry in addresses
        if entry[0] in (socket.AF_INET, socket.AF_INET6)
        and entry[4]
        and entry[4][0]
    }

    if not resolved_ips:
        raise ValueError("host resolved to no IP addresses")

    if any(not is_public_ip(address) for address in resolved_ips):
        raise ValueError("host resolves to prohibited IP address")

    # IPv4 first: fewer pointless timeouts on servers without an IPv6 route.
    ordered_ips = sorted(resolved_ips, key=lambda value: (":" in value, value))

    return parsed, hostname, ordered_ips


def clean_headers(headers):
    if headers is None:
        return {}

    if not isinstance(headers, dict):
        raise ValueError("headers must be an object")

    result = {}

    for name, value in headers.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise ValueError("headers must use string key/value pairs")

        normalized_name = name.lower().strip()

        if normalized_name not in ALLOWED_REQUEST_HEADERS:
            continue

        if len(value) > 2048:
            raise ValueError("header value too long")

        if any(char in value for char in "\r\n\0"):
            raise ValueError("header value contains control characters")

        result[normalized_name] = value

    return result


class UpstreamTooLarge(Exception):
    pass


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """
    HTTPS connection to a pre-validated address.

    Connect to the already checked IP instead of resolving the name again,
    otherwise DNS could be switched to an internal address in between (DNS
    rebinding). SNI and certificate verification use the real host name.
    """

    def __init__(self, hostname, pinned_ip, timeout):
        super().__init__(
            hostname,
            443,
            timeout=timeout,
            context=ssl.create_default_context(),
        )
        self._pinned_ip = pinned_ip

    def connect(self):
        raw_socket = socket.create_connection(
            (self._pinned_ip, self.port),
            self.timeout,
        )

        try:
            self.sock = self._context.wrap_socket(
                raw_socket,
                server_hostname=self.host,
            )
        except Exception:
            raw_socket.close()
            raise


def perform_upstream_request(method, parsed, hostname, ips, headers, body_bytes, max_bytes):
    """Returns (status, content_type, charset, bytes)."""
    deadline = time.monotonic() + UPSTREAM_TIMEOUT_SECONDS
    path = parsed.path or "/"

    if parsed.query:
        path = f"{path}?{parsed.query}"

    connection = None
    last_error = None

    # Retry with another IP only on a connection error: after the request has
    # been sent (especially POST) it must not be repeated.
    for pinned_ip in ips:
        candidate = PinnedHTTPSConnection(
            hostname,
            pinned_ip,
            timeout=UPSTREAM_TIMEOUT_SECONDS,
        )

        try:
            candidate.connect()
        except (OSError, ssl.SSLError) as error:
            candidate.close()
            last_error = error
            continue

        connection = candidate
        break

    if connection is None:
        raise last_error or OSError("no usable IP address")

    try:
        connection.request(method, path, body=body_bytes, headers=headers)
        response = connection.getresponse()

        raw_response = bytearray()

        while True:
            if time.monotonic() > deadline:
                raise TimeoutError("upstream response took too long")

            chunk = response.read(READ_CHUNK_BYTES)

            if not chunk:
                break

            raw_response.extend(chunk)

            if len(raw_response) > max_bytes:
                raise UpstreamTooLarge()

        return (
            response.status,
            response.getheader("Content-Type", ""),
            response.headers.get_content_charset() or "utf-8",
            bytes(raw_response),
        )
    finally:
        connection.close()


@app.get("/healthz")
def healthz():
    return json_response(
        200,
        ok=True,
        appVersion=APP_VERSION,
        appSha256=APP_SHA256,
        appPath=SCRIPT_PATH,
    )


@app.post("/v1/request")
def relay_request():
    request_id = str(uuid.uuid4())
    client_ip = request.remote_addr or "unknown"
    started_at = time.monotonic()

    def elapsed_ms():
        return round((time.monotonic() - started_at) * 1000)

    raw_body = request.get_data(
        cache=True,
        as_text=False,
        parse_form_data=False,
    )

    incoming_headers = dict(request.headers)

    # Header values (including Authorization) are never logged.
    log(
        "request_arrived",
        requestId=request_id,
        method=request.method,
        path=request.path,
        clientIp=client_ip,
        wsgiContentType=request.environ.get("CONTENT_TYPE", ""),
        wsgiContentLength=request.environ.get("CONTENT_LENGTH", ""),
        wsgiTransferEncoding=request.environ.get("HTTP_TRANSFER_ENCODING", ""),
        headerNames=sorted(incoming_headers.keys()),
        receivedBodyLength=len(raw_body),
    )

    if not rate_limit_allowed(client_ip):
        log("rate_limited", requestId=request_id, clientIp=client_ip)

        return json_response(429, requestId=request_id, error="RATE_LIMITED")

    authorization = incoming_headers.get("Authorization", "")
    prefix = "Bearer "

    if (
        not authorization.startswith(prefix)
        or not safe_equal(authorization[len(prefix):], RELAY_SERVICE_TOKEN)
    ):
        log("unauthorized", requestId=request_id, clientIp=client_ip)

        return json_response(401, requestId=request_id, error="UNAUTHORIZED")

    log(
        "request_body_received",
        requestId=request_id,
        bodyLength=len(raw_body),
        contentType=incoming_headers.get("Content-Type", ""),
        contentLength=incoming_headers.get("Content-Length", ""),
        transferEncoding=incoming_headers.get("Transfer-Encoding", ""),
    )

    try:
        incoming = json.loads(raw_body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        log(
            "invalid_json",
            requestId=request_id,
            bodyLength=len(raw_body),
            contentType=incoming_headers.get("Content-Type", ""),
            contentLength=incoming_headers.get("Content-Length", ""),
            transferEncoding=incoming_headers.get("Transfer-Encoding", ""),
        )

        return json_response(
            400,
            requestId=request_id,
            error="INVALID_JSON",
            bodyLength=len(raw_body),
        )

    if not isinstance(incoming, dict):
        return json_response(400, requestId=request_id, error="INVALID_REQUEST")

    method = str(incoming.get("method", "GET")).upper()

    if method not in ALLOWED_METHODS:
        return json_response(400, requestId=request_id, error="METHOD_NOT_ALLOWED")

    try:
        parsed, hostname, ips = validate_target_url(incoming.get("url"))
        forwarded_headers = clean_headers(incoming.get("headers"))
    except ValueError as error:
        log(
            "invalid_target",
            requestId=request_id,
            clientIp=client_ip,
            reason=str(error),
        )

        return json_response(
            400,
            requestId=request_id,
            error="INVALID_TARGET",
            message=str(error),
        )

    response_encoding = incoming.get("responseEncoding", "text")

    if response_encoding not in ("text", "base64"):
        return json_response(
            400,
            requestId=request_id,
            error="INVALID_RESPONSE_ENCODING",
        )

    body = incoming.get("body")

    if method == "GET" and body is not None:
        return json_response(
            400,
            requestId=request_id,
            error="GET_MUST_NOT_HAVE_BODY",
        )

    if method == "POST" and body is not None and not isinstance(body, dict):
        return json_response(
            400,
            requestId=request_id,
            error="POST_BODY_MUST_BE_OBJECT",
        )

    # Lower-case names so the client header replaces ours instead of duplicating it.
    upstream_headers = {
        "accept": "text/html,application/json;q=0.9,*/*;q=0.1",
        "user-agent": f"RestrictedRelay/{APP_VERSION}",
        "x-request-id": request_id,
        "accept-encoding": "identity",
        **forwarded_headers,
    }

    body_bytes = None

    if method == "POST" and body is not None:
        body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
        upstream_headers.setdefault("content-type", "application/json")

    try:
        status, content_type, charset, raw_response = perform_upstream_request(
            method,
            parsed,
            hostname,
            ips,
            upstream_headers,
            body_bytes,
            MAX_UPSTREAM_BINARY_BYTES
            if response_encoding == "base64"
            else MAX_UPSTREAM_RESPONSE_BYTES,
        )
    except UpstreamTooLarge:
        log(
            "upstream_response_too_large",
            requestId=request_id,
            host=hostname,
            durationMs=elapsed_ms(),
        )

        return json_response(
            502,
            requestId=request_id,
            error="UPSTREAM_RESPONSE_TOO_LARGE",
        )
    except (OSError, ssl.SSLError, http.client.HTTPException, ValueError) as error:
        log(
            "upstream_unavailable",
            requestId=request_id,
            host=hostname,
            durationMs=elapsed_ms(),
            errorType=type(error).__name__,
            reason=str(error),
        )

        return json_response(
            502,
            requestId=request_id,
            error="UPSTREAM_UNAVAILABLE",
        )

    if response_encoding == "base64":
        result_data = {"base64": base64.b64encode(raw_response).decode("ascii")}
    else:
        try:
            upstream_text = raw_response.decode(charset, errors="replace")
        except LookupError:
            upstream_text = raw_response.decode("utf-8", errors="replace")

        result_data = {"text": upstream_text}

    log(
        "relay_completed",
        requestId=request_id,
        method=method,
        host=hostname,
        upstreamStatus=status,
        responseBytes=len(raw_response),
        durationMs=elapsed_ms(),
    )

    # The relay HTTP status is always 200; the site status is in upstreamStatus.
    return json_response(
        200,
        requestId=request_id,
        upstreamStatus=status,
        contentType=content_type,
        data=result_data,
    )


@app.errorhandler(413)
def request_too_large(_error):
    return json_response(413, error="REQUEST_BODY_TOO_LARGE")


if __name__ == "__main__":
    # Local debugging only; in production use Gunicorn (simple-relay.service).
    log_startup("relay_started")

    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)
