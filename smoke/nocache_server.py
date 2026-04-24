import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> None:
    directory = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 5177
    os.chdir(directory)
    server = ThreadingHTTPServer(("", port), NoCacheHandler)
    print(f"serving {directory} on :{port} with no-store headers", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
