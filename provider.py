"""Bounded, cached read-only adapter for the official website's JSON responses."""
from __future__ import annotations

from concurrent.futures import Future
from datetime import datetime, timedelta
import http.cookiejar
import json
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from domain import CHINA, SEATS, Segment, InputError, iso, minutes, money_fen, now_cn
from version import __version__

ROOT = Path(__file__).parent
BASE = 'https://kyfw.12306.cn'


class DataError(RuntimeError):
    pass


class QueryLimit(DataError):
    pass


def decode_inventory(parts):
    """Decode physical inventory columns using the train's advertised seat types.

    The soft-sleeper column is shared by traditional soft sleepers, modern
    first-class beds and dynamic sleepers. A fixed column-to-product mapping
    loses F inventory and then cannot match the execution-price response.
    """
    seats = {code: parts[index] for code, (_, index, _) in SEATS.items()}
    advertised = parts[35]
    if 'F' in advertised:
        seats['F'] = parts[23] or parts[33]
        if '4' not in advertised:
            seats['4'] = ''
    else:
        seats['F'] = ''
    if 'I' in advertised:
        seats['I'] = parts[23]
        if '4' not in advertised:
            seats['4'] = ''
    else:
        seats['I'] = ''
    if 'J' in advertised:
        seats['J'] = parts[28]
        if '3' not in advertised:
            seats['3'] = ''
    else:
        seats['J'] = ''
    return seats


class Stations:
    def __init__(self, path=None):
        raw = (path or ROOT / 'data' / 'stations.js').read_text(encoding='utf-8')
        self.items = []
        for chunk in raw.split('@')[1:]:
            parts = chunk.split('|')
            if len(parts) >= 8 and re.fullmatch('[A-Z]{3}', parts[2]):
                self.items.append(dict(name=parts[1], code=parts[2], pinyin=parts[3], abbr=parts[4], city=parts[7] or parts[1]))
        self.by_code = {s['code']: s for s in self.items}
        self.by_name = {s['name']: s for s in self.items}
        self.cities = {}
        for station in self.items:
            self.cities.setdefault(station['city'], []).append(station)

    def city(self, code):
        return self.by_code.get(code, {}).get('city', code)

    def name(self, code):
        return self.by_code.get(code, {}).get('name', code)

    def resolve(self, query):
        """Exact station suffix or telecode locks a station; city searches group it."""
        query = query.strip()
        if query.upper() in self.by_code:
            station = self.by_code[query.upper()]
            return {'query': query, 'city': station['city'], 'code': station['code'], 'exact': True, 'name': station['name']}
        if query.endswith('站') and query[:-1] in self.by_name:
            station = self.by_name[query[:-1]]
            return {'query': query, 'city': station['city'], 'code': station['code'], 'exact': True, 'name': station['name']}
        if query in self.cities:
            group = self.cities[query]
            station = next((s for s in group if s['name'] == query), group[0])
            return {'query': query, 'city': query, 'code': station['code'], 'exact': False, 'name': query}
        if query in self.by_name:
            station = self.by_name[query]
            return {'query': query, 'city': station['city'], 'code': station['code'], 'exact': True, 'name': station['name']}
        raise InputError(f'未找到“{query}”，请从城市或车站建议中选择。')

    def suggestions(self, query):
        q = query.strip().lower()
        if not q:
            return []
        results = []
        for city, group in self.cities.items():
            if city.lower().startswith(q) or any(q == s['pinyin'] or q == s['abbr'] for s in group if s['name'] == city):
                results.append({'value': city, 'label': city, 'type': '城市 · 查询同城车站'})
        for s in self.items:
            if q in s['name'].lower() or s['pinyin'].startswith(q) or s['abbr'].startswith(q) or q == s['code'].lower():
                results.append({'value': s['name'] + '站', 'label': s['name'] + '站', 'type': s['city'] + ' · 指定车站'})
            if len(results) >= 14:
                break
        return results[:14]


class Budget:
    def __init__(self, maximum=84, seconds=110, cancel=None):
        self.maximum, self.used = maximum, 0
        self.started, self.seconds = time.monotonic(), seconds
        self.cache_hits = 0
        self.cancel = cancel or threading.Event()

    def check(self):
        if self.cancel.is_set():
            raise QueryLimit('查询已取消。')
        if time.monotonic() - self.started >= self.seconds:
            raise QueryLimit('已达到本次查询的时间预算，返回已核实结果。')

    def take(self):
        self.check()
        if self.used >= self.maximum:
            raise QueryLimit('已达到本次查询的请求预算，返回已核实结果。')
        self.used += 1


class RailClient:
    def __init__(self, stations):
        self.stations = stations
        self._cache = {}
        self._pending = {}
        self._cache_lock = threading.Lock()
        self._network_lock = threading.Lock()
        self._last_call = 0.
        self._initialized = 0.
        self._blocked_until = 0.
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def _request(self, path, params, budget):
        with self._network_lock:
            budget.check()
            if time.monotonic() < self._blocked_until:
                raise DataError('上游暂时不可用，查询已暂停；请稍后再试。')
            if time.monotonic() - self._initialized > 300:
                budget.take()
                self._fetch('/otn/leftTicket/init', None)
                self._initialized = time.monotonic()
            budget.take()
            return self._fetch(path, params)

    def _fetch(self, path, params):
        delay = .3 - (time.monotonic() - self._last_call)
        if delay > 0:
            time.sleep(delay)
        url = BASE + path + ('?' + urllib.parse.urlencode(params) if params else '')
        request = urllib.request.Request(url, headers={
            'User-Agent': f'RailwayPlanner/{__version__} (read-only route planning)',
            'Accept': 'application/json,text/html', 'Referer': BASE + '/otn/leftTicket/init'})
        try:
            with self._opener.open(request, timeout=10) as response:
                final = urllib.parse.urlparse(response.url)
                if final.hostname != 'kyfw.12306.cn' or any(s in final.path for s in ('error', 'ntce', 'login')):
                    self._blocked_until = time.monotonic() + 60
                    raise DataError('上游要求验证或返回异常页面，已停止自动查询。')
                body = response.read(4_000_000)
                if not params:
                    return None
                try:
                    data = json.loads(body)
                except (ValueError, UnicodeError) as exc:
                    self._blocked_until = time.monotonic() + 60
                    raise DataError('上游没有返回可用 JSON，已暂停查询。') from exc
                if not isinstance(data, dict) or data.get('status') is not True:
                    raise DataError('上游查询未成功，请稍后重试。')
                data['_queried_at'] = iso(now_cn())
                return data
        except urllib.error.HTTPError as exc:
            self._blocked_until = time.monotonic() + 60
            raise DataError(f'上游返回 HTTP {exc.code}，已暂停查询。') from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise DataError('铁路查询连接失败或超时；本次不会自动重试。') from exc
        finally:
            self._last_call = time.monotonic()

    def cached(self, path, params, budget, ttl=45):
        budget.check()
        key = (path, tuple(sorted(params.items())))
        with self._cache_lock:
            cached = self._cache.get(key)
            if cached and cached[0] > time.monotonic():
                budget.cache_hits += 1
                return cached[1]
            future = self._pending.get(key)
            owner = future is None
            if owner:
                future = self._pending[key] = Future()
        if not owner:
            try:
                value = future.result(timeout=15)
                budget.cache_hits += 1
                return value
            except TimeoutError as exc:
                raise DataError('等待合并查询超时。') from exc
        try:
            data = self._request(path, params, budget)
            with self._cache_lock:
                if len(self._cache) > 2500:
                    current = time.monotonic()
                    self._cache = {k: v for k, v in self._cache.items() if v[0] > current}
                    if len(self._cache) > 2500:
                        self._cache.clear()
                self._cache[key] = (time.monotonic() + ttl, data)
            future.set_result(data)
            return data
        except Exception as exc:
            future.set_exception(exc)
            raise
        finally:
            with self._cache_lock:
                self._pending.pop(key, None)

    def tickets(self, origin, destination, date, budget):
        data = self.cached('/otn/leftTicket/queryG', {
            'leftTicketDTO.train_date': date, 'leftTicketDTO.from_station': origin['code'],
            'leftTicketDTO.to_station': destination['code'], 'purpose_codes': 'ADULT'}, budget)
        result = data.get('data', {}).get('result')
        if not isinstance(result, list):
            raise DataError('余票响应结构变化，无法可靠解析。')
        output = []
        for record in result:
            p = record.split('|')
            if len(p) < 36:
                continue
            if origin['exact'] and p[6] != origin['code']:
                continue
            if destination['exact'] and p[7] != destination['code']:
                continue
            # City-level responses may contain multiple station names.
            if not origin['exact'] and self.stations.city(p[6]) != origin['city']:
                continue
            if not destination['exact'] and self.stations.city(p[7]) != destination['city']:
                continue
            try:
                depart = datetime.fromisoformat(date + 'T' + p[8])
                arrive = depart + timedelta(minutes=minutes(p[10]))
            except ValueError:
                continue
            seats = decode_inventory(p)
            output.append(Segment(p[2], p[3], p[6], p[7], self.stations.name(p[6]),
                self.stations.name(p[7]), depart, arrive, p[16], p[17], p[35], seats,
                p[11] == 'Y', checked_at=data['_queried_at']))
        return output

    def fares(self, segment, budget):
        try:
            data = self.cached('/otn/leftTicket/queryTicketPrice', {
                'train_no': segment.train_no, 'from_station_no': segment.from_seq,
                'to_station_no': segment.to_seq, 'seat_types': segment.seat_types,
                'train_date': segment.depart.date().isoformat()}, budget, ttl=45)
            raw = data.get('data')
            if not isinstance(raw, dict):
                raise DataError('票价响应结构变化，价格待确认。')
            segment.prices = {}
            for code, (_, _, field) in SEATS.items():
                candidates = (field, 'A' + code, code)
                for candidate in candidates:
                    price = money_fen(raw.get(candidate))
                    if price is not None:
                        segment.prices[code] = price
                        break
            segment.fare_checked = data['_queried_at']
        except QueryLimit:
            raise
        except DataError as exc:
            segment.fare_error = str(exc)

    def transfers(self, origin, destination, date, middle, budget):
        data = self.cached('/lcquery/queryG', {'train_date': date,
            'from_station_telecode': origin['code'], 'to_station_telecode': destination['code'],
            'middle_station': middle, 'result_index': '0', 'can_query': 'Y',
            'isShowWZ': 'N', 'purpose_codes': '00', 'channel': 'E'}, budget)
        inner = data.get('data', {})
        rows = inner.get('middleList', [])
        if not isinstance(rows, list):
            raise DataError('中转响应结构变化。')
        # Only discover candidate station pairs, then re-query dated inventory.
        pairs = []
        for row in rows:
            legs = row.get('fullList') or row.get('trainList') or []
            if len(legs) < 2:
                continue
            names = [legs[0].get('to_station_name'), legs[1].get('from_station_name')]
            resolved = [self.stations.by_name.get(name) for name in names]
            if all(resolved):
                pair = (resolved[0]['code'], resolved[1]['code'])
                if pair not in pairs:
                    pairs.append(pair)
        return pairs, len(rows)
