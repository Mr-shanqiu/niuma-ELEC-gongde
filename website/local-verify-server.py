"""Local static server that forwards /api/ to the live site.

Only for verifying the library UI against real catalogue data on a local
build. It forwards GET/HEAD only and never writes anything upstream.
"""
import http.server
import socketserver
import urllib.request
import urllib.error
import os

UPSTREAM = "https://gongde.zqscreen.cn"
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._proxy("GET")
        return super().do_GET()

    def do_HEAD(self):
        if self.path.startswith("/api/"):
            return self._proxy("HEAD")
        return super().do_HEAD()

    def _proxy(self, method):
        url = UPSTREAM + self.path
        request = urllib.request.Request(url, method=method, headers={
            "Accept": self.headers.get("Accept", "*/*"),
            "User-Agent": "local-verify",
        })
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read()
                self.send_response(response.status)
                for key in ("Content-Type", "Cache-Control"):
                    if response.headers.get(key):
                        self.send_header(key, response.headers[key])
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if method == "GET":
                    self.wfile.write(body)
        except urllib.error.HTTPError as error:
            body = error.read()
            self.send_response(error.code)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if method == "GET":
                self.wfile.write(body)
        except Exception as error:  # noqa: BLE001 - surfaced to the test page
            self.send_error(502, str(error))

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    with socketserver.ThreadingTCPServer(("127.0.0.1", 8772), Handler) as httpd:
        httpd.daemon_threads = True
        httpd.serve_forever()
