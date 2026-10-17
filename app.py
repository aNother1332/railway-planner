"""Local web application. Run: python app.py --port 8765"""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import json
import mimetypes
from pathlib import Path
import secrets
import threading
import time
import urllib.parse

from domain import InputError, SearchOptions, iso, now_cn
from provider import RailClient, Stations, QueryLimit
from planner import Planner
from version import __version__

ROOT = Path(__file__).parent


class Application:
    def __init__(self):
        self.stations = Stations()
        self.planner = Planner(RailClient(self.stations), self.stations)
        self.executor = ThreadPoolExecutor(max_workers=2)
        self.jobs = {}
        self.lock = threading.RLock()

    def start(self, payload):
        options = SearchOptions.parse(payload)
        self.stations.resolve(options.origin)
        self.stations.resolve(options.destination)
        if options.via:
            self.stations.resolve(options.via)
        with self.lock:
            if sum(j['status'] == 'running' for j in self.jobs.values()) >= 2:
                raise InputError('已有两个查询正在进行，请等待完成后再查。')
            if len(self.jobs) > 30:
                finished = sorted((k for k, j in self.jobs.items() if j['status'] != 'running'), key=lambda k: self.jobs[k]['created'])
                for key in finished[:len(self.jobs) - 20]:
                    del self.jobs[key]
            job_id = secrets.token_urlsafe(18)
            job = {'id': job_id, 'status': 'running', 'message': '准备查询', 'progress': 0,
                   'created': time.monotonic(), '_cancel': threading.Event()}
            self.jobs[job_id] = job
        def progress(message, percent):
            with self.lock:
                job.update(message=message, progress=percent)
        def run():
            try:
                result = self.planner.search(options, progress, job['_cancel'])
                with self.lock:
                    job.update(status='cancelled' if job['_cancel'].is_set() else 'complete', result=result)
            except QueryLimit as exc:
                with self.lock:
                    job.update(status='cancelled', error=str(exc))
            except Exception as exc:
                import logging
                logging.exception('Search failed')
                with self.lock:
                    job.update(status='error', error='查询未能完成，请稍后再试。' if not isinstance(exc, InputError) else str(exc))
        self.executor.submit(run)
        return job_id

    def snapshot(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return {k: v for k, v in job.items() if not k.startswith('_') and k != 'created'} if job else None


class Handler(BaseHTTPRequestHandler):
    app: Application

    def log_message(self, fmt, *args):
        # No query payloads or personal data in access logs.
        pass

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == '/api/config':
            today = now_cn().date()
            return self.send_json({'today': today.isoformat(), 'sale_end': (today + timedelta(days=14)).isoformat(),
                'now': iso(now_cn()), 'station_count': len(self.app.stations.items), 'version': __version__})
        if url.path == '/api/stations':
            query = urllib.parse.parse_qs(url.query).get('q', [''])[0][:30]
            return self.send_json(self.app.stations.suggestions(query))
        if url.path.startswith('/api/search/'):
            result = self.app.snapshot(url.path.rsplit('/', 1)[-1])
            return self.send_json(result if result else {'error': '查询已过期，请重新查询。'}, 200 if result else 404)
        files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg'}
        name = files.get(url.path)
        if not name:
            return self.send_json({'error': '未找到页面'}, 404)
        body = (ROOT / 'web' / name).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(name)[0] + '; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        origin = self.headers.get('Origin')
        if origin and urllib.parse.urlparse(origin).netloc != self.headers.get('Host'):
            return self.send_json({'error': '不接受跨站请求。'}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= 16384:
                return self.send_json({'error': '请求过大。'}, 413)
            payload = json.loads(self.rfile.read(length)) if length else {}
            if not isinstance(payload, dict):
                raise InputError('请求必须是 JSON 对象。')
            if self.path == '/api/search':
                return self.send_json({'id': self.app.start(payload)}, 202)
            if self.path.startswith('/api/cancel/'):
                job_id = self.path.rsplit('/', 1)[-1]
                with self.app.lock:
                    job = self.app.jobs.get(job_id)
                    if job:
                        job['_cancel'].set()
                return self.send_json({'cancelled': bool(job)})
            return self.send_json({'error': '未知接口。'}, 404)
        except (ValueError, InputError) as exc:
            return self.send_json({'error': str(exc)}, 400)


def main():
    parser = argparse.ArgumentParser(description='转个弯 · 火车中转规划')
    parser.add_argument('--version', action='version', version=__version__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--open-browser', action='store_true')
    args = parser.parse_args()
    Handler.app = Application()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'Railway Planner ready: http://{args.host}:{args.port}', flush=True)
    if args.open_browser:
        import webbrowser
        threading.Timer(.4, lambda: webbrowser.open(f'http://127.0.0.1:{args.port}')).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for job in Handler.app.jobs.values():
            job['_cancel'].set()
        server.server_close()
        Handler.app.executor.shutdown(wait=False, cancel_futures=True)


if __name__ == '__main__':
    main()
