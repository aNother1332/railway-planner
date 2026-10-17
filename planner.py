"""One-transfer search: official candidates plus bounded hub expansion."""
from dataclasses import replace
from datetime import datetime, timedelta
import math
import re
import time

from domain import (SEATS, SLEEPERS, availability, iso, night_overlap, now_cn,
                    rank_routes, route_from_segments)
from provider import Budget, DataError, QueryLimit

# Representative regional rail hubs; this is a declared finite search scope.
HUBS = {
    '北京': (39.9,116.4,['北京西','北京南','北京']),
    '天津': (39.1,117.2,['天津西','天津']),
    '石家庄': (38.0,114.5,['石家庄']),
    '太原': (37.9,112.6,['太原南','太原']),
    '济南': (36.7,117.0,['济南西','济南']),
    '德州': (37.4,116.3,['德州东','德州']),
    '郑州': (34.7,113.6,['郑州东','郑州']),
    '商丘': (34.4,115.7,['商丘']),
    '徐州': (34.3,117.2,['徐州东','徐州']),
    '蚌埠': (32.9,117.4,['蚌埠南','蚌埠']),
    '南京': (32.1,118.8,['南京南','南京']),
    '合肥': (31.8,117.2,['合肥南','合肥']),
    '上海': (31.2,121.5,['上海虹桥','上海']),
    '杭州': (30.3,120.2,['杭州东','杭州']),
    '宁波': (29.9,121.5,['宁波']),
    '武汉': (30.6,114.3,['武汉','武昌','汉口']),
    '长沙': (28.2,112.9,['长沙南','长沙']),
    '株洲': (27.8,113.1,['株洲西','株洲']),
    '衡阳': (26.9,112.6,['衡阳东','衡阳']),
    '广州': (23.1,113.3,['广州南','广州']),
    '深圳': (22.5,114.1,['深圳北','深圳东']),
    '南昌': (28.7,115.9,['南昌西','南昌']),
    '九江': (29.7,116.0,['九江','庐山']),
    '上饶': (28.5,118.0,['上饶']),
    '福州': (26.1,119.3,['福州','福州南']),
    '厦门': (24.5,118.1,['厦门北','厦门']),
    '西安': (34.3,108.9,['西安北','西安']),
    '兰州': (36.1,103.8,['兰州西','兰州']),
    '成都': (30.7,104.1,['成都东','成都西']),
    '重庆': (29.6,106.6,['重庆北','重庆西']),
    '贵阳': (26.6,106.7,['贵阳北','贵阳']),
    '怀化': (27.6,110.0,['怀化南','怀化']),
    '昆明': (25.0,102.7,['昆明南','昆明']),
    '南宁': (22.8,108.3,['南宁东','南宁']),
    '桂林': (25.3,110.3,['桂林北','桂林']),
    '柳州': (24.3,109.4,['柳州']),
    '沈阳': (41.8,123.4,['沈阳北','沈阳']),
    '长春': (43.9,125.3,['长春西','长春']),
    '哈尔滨': (45.8,126.6,['哈尔滨西','哈尔滨']),
    '大连': (38.9,121.6,['大连北','大连']),
    '青岛': (36.1,120.4,['青岛北','青岛']),
    '呼和浩特': (40.8,111.7,['呼和浩特东','呼和浩特']),
    '乌鲁木齐': (43.8,87.6,['乌鲁木齐']),
    '西宁': (36.6,101.8,['西宁']),
    '银川': (38.5,106.2,['银川']),
    '襄阳': (32.0,112.1,['襄阳东','襄阳']),
    '信阳': (32.1,114.1,['信阳东','信阳']),
}


def distance(a, b):
    return math.hypot(a[0] - b[0], (a[1] - b[1]) * .8)


def choose_hubs(origin, destination, count):
    excluded = (origin, destination)
    available = [name for name in HUBS if name not in excluded]
    if origin in HUBS and destination in HUBS:
        a, b = HUBS[origin], HUBS[destination]
        direct = distance(a, b)
        # Detour plus a mild penalty for a hub too close to either endpoint.
        corridor = sorted(available, key=lambda name: (
            distance(a, HUBS[name]) + distance(HUBS[name], b) - direct
            + max(0, direct * .12 - min(distance(a, HUBS[name]), distance(b, HUBS[name])))))
        # Search a portfolio: corridor hubs AND gateways on the approach side
        # of the destination. Sleeping through a longer first leg can dominate
        # a geographically shorter route that requires a midnight change.
        direction = (a[0]-b[0], (a[1]-b[1])*.8)
        def on_approach(name):
            point = HUBS[name]
            delta = (point[0]-b[0], (point[1]-b[1])*.8)
            return (delta[0]*direction[0] + delta[1]*direction[1] > 0
                and distance(point,b) <= max(2.,direct*.38))
        gateways = sorted((name for name in available if on_approach(name)),
            key=lambda name: distance(HUBS[name],b))
        reserve = min(2, max(1,count//2))
        selected = list(dict.fromkeys(corridor[:max(1,count-reserve)] + gateways[:reserve]))
        for name in corridor:
            if len(selected) >= count:
                break
            if name not in selected:
                selected.append(name)
        return selected[:count]
    return [x for x in ['郑州','武汉','南京','长沙','南昌','徐州','西安','广州'] if x not in excluded][:count]


def shortlist_routes(direct, transfers, limit=36):
    """Reserve coverage for distinct first trains before extra onward variants.

    Round-robin gateway cities as well, so one large station's many second-leg
    departures cannot consume all pricing slots. No train numbers are special.
    """
    selected = direct[:min(8,limit)]
    if len(selected) >= limit:
        return selected
    families = {}
    cities = {}
    for item in transfers:
        first = item[0][0]
        family = first.key
        if family not in families:
            families[family] = []
            cities.setdefault(item[2]['via'], []).append(family)
        families[family].append(item)
    family_order = []
    for index in range(max((len(group) for group in cities.values()), default=0)):
        for group in cities.values():
            if index < len(group):
                family_order.append(group[index])
    for onward_index in range(2):
        for family in family_order:
            group = families[family]
            if onward_index < len(group):
                selected.append(group[onward_index])
                if len(selected) >= limit:
                    return selected
    for item in direct[min(8,limit):]:
        if len(selected) >= limit:
            break
        selected.append(item)
    return selected


class Planner:
    def __init__(self, client, stations):
        self.client, self.stations = client, stations

    def search(self, options, progress=lambda *_: None, cancel=None):
        started = time.monotonic()
        budget = Budget(cancel=cancel)
        origin = self.stations.resolve(options.origin)
        destination = self.stations.resolve(options.destination)
        warnings, failures, pair_list, searched = [], [], [], []
        candidate_counts = {}
        segments_by_key, ticket_cache = {}, {}
        rough = {}
        partial = False
        sale_end = now_cn().date() + timedelta(days=14)
        dates = [options.earliest.date() + timedelta(days=i) for i in range(options.depart_days)]
        dates = [d for d in dates if d <= min(options.latest.date(), sale_end)]
        # Keep the original budget for the final pass only, after real fares.
        unpriced_options = replace(options, budget=None)

        def add_pair(a, b):
            if a not in self.stations.by_code or b not in self.stations.by_code:
                return
            if (a, b) not in pair_list:
                pair_list.append((a, b))

        def exact(code):
            return self.stations.resolve(code)

        def tickets(a, b, date):
            nonlocal partial
            key = (a['code'], a['exact'], b['code'], b['exact'], date.isoformat())
            if key in ticket_cache:
                return ticket_cache[key]
            if date > sale_end or date < now_cn().date():
                partial = True
                if '部分接续日期尚未进入预售期，未核实这些路段。' not in warnings:
                    warnings.append('部分接续日期尚未进入预售期，未核实这些路段。')
                return []
            try:
                values = self.client.tickets(a, b, date.isoformat(), budget)
                for value in values:
                    segments_by_key.setdefault(value.key, value)
                values = [segments_by_key[v.key] for v in values]
                ticket_cache[key] = values
                return values
            except QueryLimit:
                raise
            except DataError as exc:
                partial = True
                failures.append(f'{a["name"]}→{b["name"]} {date}: {exc}')
                ticket_cache[key] = []
                return []

        def consider(legs, source):
            route = route_from_segments(legs, unpriced_options, self.stations.city, source)
            if route:
                key = tuple(s.key for s in legs)
                rough.setdefault(key, (legs, source, route))

        progress('正在查询直达列车', 5)
        try:
            for date in dates:
                for segment in tickets(origin, destination, date):
                    consider([segment], '直达查询')
            progress('正在查找中转枢纽', 13)
            via = self.stations.resolve(options.via) if options.via else None
            if via:
                # Autocomplete adds “站” to lock a station; route comparisons use
                # the canonical station name, not that input suffix or telecode.
                options = replace(options, via=via['name'], via_code=via['code'] if via['exact'] else '')
                unpriced_options = replace(options, budget=None)
            # Always include an explicitly selected hub first.
            hub_cities = []
            if via:
                hub_cities.append(via['city'])
                if via['exact']:
                    add_pair(via['code'], via['code'])
            if not (via and options.via_mode == 'must'):
                hub_cities += choose_hubs(origin['city'], destination['city'], options.hubs)
            hub_cities = list(dict.fromkeys(hub_cities))
            blocked = set(re.split(r'[,，、\s]+', options.exclude))
            for city in hub_cities:
                if city in blocked or (via and via['exact'] and city == via['city']):
                    continue
                names = HUBS.get(city, (0, 0, [s['name'] for s in self.stations.cities.get(city, [])]))[2]
                codes = [self.stations.by_name[n]['code'] for n in names[:2] if n in self.stations.by_name]
                for code in codes:
                    add_pair(code, code)
                if options.allow_cross_station and len(codes) == 2:
                    add_pair(codes[0], codes[1])
                    add_pair(codes[1], codes[0])
            try:
                suggested, row_count = self.client.transfers(origin, destination, dates[0].isoformat(), via['code'] if via else '', budget)
                for a, b in suggested:
                    if via and options.via_mode == 'must' and via['city'] != self.stations.city(a):
                        continue
                    if not options.allow_cross_station and a != b:
                        continue
                    if self.stations.city(a) in blocked:
                        continue
                    if len(pair_list) < 12:
                        add_pair(a, b)
                warnings.append(f'官方中转仅读取首批 {row_count} 个候选，另行扩展枢纽；本次不代表全部路线。')
            except QueryLimit:
                raise
            except DataError as exc:
                partial = True
                failures.append('官方候选查询：' + str(exc))

            # Limit expansion, reserving at least 30 requests for exact fare lookup.
            pair_limit = 10 if options.depart_days == 1 else 6
            if len(pair_list) > pair_limit:
                warnings.append('本次已按查询预算限制枢纽站组合数量。')
                partial = True
            pair_list = pair_list[:pair_limit]
            for index, (a, b) in enumerate(pair_list):
                budget.check()
                if budget.used >= 48:
                    partial = True
                    warnings.append('已停止扩展枢纽，为候选路线票价核验保留预算。')
                    break
                searched.append({'city': self.stations.city(a), 'arrival_station': self.stations.name(a), 'departure_station': self.stations.name(b)})
                count_before = len(rough)
                progress(f'正在组合经 {self.stations.name(a)} 的路线', 18 + int(index / max(1, len(pair_list)) * 37))
                for date in dates:
                    firsts = [s for s in tickets(origin, exact(a), date) if options.earliest <= s.depart < options.earliest + timedelta(days=options.depart_days) and s.arrive < options.latest]
                    for first in firsts:
                        if not any(availability(first.seats.get(c)) == 'available' for c in options.seats) and not options.include_unavailable:
                            continue
                        transfer_max = options.stay_max if options.stay_max is not None else options.max_transfer
                        earliest_second = first.arrive + timedelta(minutes=options.min_transfer)
                        latest_second = min(first.arrive + timedelta(minutes=transfer_max), options.latest)
                        day = earliest_second.date()
                        while day <= latest_second.date():
                            for second in tickets(exact(b), destination, day):
                                if earliest_second <= second.depart <= latest_second:
                                    consider([first, second], '枢纽扩展')
                            day += timedelta(days=1)
                candidate_counts[self.stations.name(a) + '→' + self.stations.name(b)] = len(rough) - count_before
        except QueryLimit as exc:
            partial = True
            warnings.append(str(exc))

        if cancel and cancel.is_set():
            raise QueryLimit('查询已取消。')
        progress(f'已组合 {len(rough)} 条候选，正在核验查询票价', 60)
        candidates = list(rough.values())
        # Spread selection across departure times and hubs rather than sending
        # only the first thirty nearly identical train combinations for pricing.
        def rough_score(item):
            route = item[2]
            if options.mode == 'sleeper':
                return (route['daytime_minutes'], route['arrive'], route['duration'], -route['rest_minutes'])
            return (route['duration'] + route['wait'] * .3, route['depart'])
        candidates.sort(key=rough_score)
        direct = [x for x in candidates if len(x[0]) == 1]
        transfers = [x for x in candidates if len(x[0]) == 2]
        def diverse(items):
            # Round-robin fast, conventional and night routes. In particular,
            # price searches must not shortlist only the fastest high-speed legs.
            buckets = [items,
                [x for x in items if any(not s.code.startswith(('G', 'C', 'D')) for s in x[0])],
                sorted((x for x in items if any(night_overlap(s.depart, s.arrive) >= 240 for s in x[0])),
                    key=lambda x: -max(night_overlap(s.depart, s.arrive) for s in x[0]))]
            seen, result = set(), []
            maximum = max((len(b) for b in buckets), default=0)
            for i in range(maximum):
                for bucket in buckets:
                    if i < len(bucket):
                        item = bucket[i]
                        identity = tuple(s.key for s in item[0])
                        if identity not in seen:
                            seen.add(identity)
                            result.append(item)
            return result
        if options.mode != 'sleeper':
            direct, transfers = diverse(direct), diverse(transfers)
        selected = shortlist_routes(direct, transfers)
        if len(selected) < len(candidates):
            partial = True
            warnings.append(f'共 {len(candidates)} 条符合时刻与席别条件的候选，本次优先核验 {len(selected)} 条；价格最低仅针对已核验结果。')
        checked = set()
        try:
            for index, (legs, _, _) in enumerate(selected):
                progress(f'正在核验票价 {index + 1}/{len(selected)}', 60 + int(index / max(1, len(selected)) * 33))
                for segment in legs:
                    if segment.key not in checked:
                        self.client.fares(segment, budget)
                        checked.add(segment.key)
        except QueryLimit as exc:
            partial = True
            warnings.append(str(exc))

        final = []
        for legs, source, _ in selected:
            route = route_from_segments(legs, options, self.stations.city, source)
            if route:
                final.append(route)
        final = rank_routes(final, options.mode)
        eligible = [r for r in final if r['available'] and r['priced']]
        highlights = {}
        if eligible:
            highlights['price'] = min(eligible, key=lambda r: (r['price_fen'], r['duration']))['id']
            highlights['duration'] = min(eligible, key=lambda r: r['duration'])['id']
            rests = [r for r in eligible if r['rest_minutes'] >= options.min_sleep]
            if rests:
                highlights['sleeper'] = min(rests, key=lambda r: (-r['rest_minutes'], r['daytime_minutes']))['id']
        fare_failures = {s.fare_error for s in segments_by_key.values() if s.fare_error}
        if fare_failures:
            partial = True
            warnings.append('部分票价查询失败，相关路线标记为价格待确认。')
        if failures:
            warnings.append(f'{len(failures)} 个区间查询未完成；未返回结果不代表没有路线。')
        if options.allow_cross_station:
            warnings.append('同城换站按至少 120 分钟筛选，未接入市内交通实时耗时，请自行核实交通条件。')
        if options.mode == 'sleeper':
            warnings.append('可休息时段按 22:00—次日 08:00 与卧铺乘车时间的连续重叠计算，不代表实际睡眠质量。')
        progress('查询完成', 100)
        return {'routes': final, 'highlights': highlights, 'partial': partial,
            'warnings': list(dict.fromkeys(warnings)), 'errors': failures[:8],
            'checked_at': iso(now_cn()), 'elapsed_seconds': round(time.monotonic() - started, 1),
            'scope': {'origin': origin, 'destination': destination,
                'dates': [d.isoformat() for d in dates], 'hubs': searched,
                'requests': budget.used, 'request_limit': budget.maximum,
                'cache_hits': budget.cache_hits, 'candidate_count': len(candidates),
                'verified_candidates': len(selected), 'priced_segments': len(checked),
                'candidate_counts_by_station': candidate_counts,
                'selection_policy': '先覆盖不同中转城市和前序车次，再保留接续备选',
                'early_policy': options.early_policy if options.avoid_early else 'allow',
                'max_transfers': 1, 'cache_ttl_seconds': 45},
            'empty_hint': ('请检查席别、到达期限或中转限制；夜间卧铺模式可适当降低可休息时长。' if not final else None)}
