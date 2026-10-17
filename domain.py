"""Route rules and time/seat calculations, independent of the network."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import re

CHINA = timezone(timedelta(hours=8))
SEATS = {
    'O': ('二等座', 30, 'O'), 'M': ('一等座', 31, 'M'),
    '9': ('商务座', 32, 'A9'), '3': ('硬卧', 28, 'A3'),
    '4': ('软卧', 23, 'A4'), '6': ('高级软卧', 21, 'A6'),
    'F': ('动卧', 33, 'F'), 'I': ('一等卧', 23, 'AI'),
    'J': ('二等卧', 28, 'AJ'), '1': ('硬座', 29, 'A1'),
    'WZ': ('无座', 26, 'WZ'),
}
SLEEPERS = {'3', '4', '6', 'F', 'I', 'J'}
DEFAULT_SEATS = ['O', '3', '4', 'F', 'I', 'J']


class InputError(ValueError):
    pass


def now_cn():
    return datetime.now(CHINA).replace(tzinfo=None)


def iso(value):
    return value.isoformat(timespec='minutes')


def minutes(value):
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value or '')
    match = re.fullmatch(r'(\d+):(\d{2})', text)
    if match:
        return int(match[1]) * 60 + int(match[2])
    match = re.fullmatch(r'(?:(\d+)小时)?(?:(\d+)分(?:钟)?)?', text)
    if match and any(match.groups()):
        return int(match[1] or 0) * 60 + int(match[2] or 0)
    if text.isdigit():
        return int(text)
    raise ValueError('无法识别历时：' + text)


def money_fen(value):
    """Only parse formatted execution prices; never infer raw numeric units."""
    if not isinstance(value, str) or not re.fullmatch(r'[¥￥]\s*\d+(?:\.\d{1,2})?', value):
        return None
    from decimal import Decimal
    return int(Decimal(re.sub(r'[¥￥\s]', '', value)) * 100)


def availability(raw):
    value = str(raw or '')
    if value == '有' or (value.isdigit() and int(value) > 0):
        return 'available'
    if value in ('无', '0', '候补'):
        return 'unavailable'
    return 'unknown'


def night_overlap(start, end):
    """Longest continuous overlap with a 22:00–08:00 rest window."""
    best = 0
    day = start.date() - timedelta(days=1)
    while day <= end.date():
        left = datetime.combine(day, datetime.min.time()).replace(hour=22)
        right = left + timedelta(hours=10)
        best = max(best, int(max(timedelta(), min(end, right) - max(start, left)).total_seconds() / 60))
        day += timedelta(days=1)
    return best


def daylight_minutes(start, end):
    total = 0
    day = start.date()
    while day <= end.date():
        left = datetime.combine(day, datetime.min.time()).replace(hour=8)
        right = left.replace(hour=22)
        total += int(max(timedelta(), min(end, right) - max(start, left)).total_seconds() / 60)
        day += timedelta(days=1)
    return total


def touches_early_hours(start, end):
    """Transfer interval overlapping 00:00–06:00, including cross-midnight."""
    day = start.date()
    while day <= end.date():
        left = datetime.combine(day, datetime.min.time())
        right = left.replace(hour=6)
        if max(start, left) < min(end, right) or left <= start < right or left <= end < right:
            return True
        day += timedelta(days=1)
    return False


@dataclass
class Segment:
    train_no: str
    code: str
    from_code: str
    to_code: str
    from_name: str
    to_name: str
    depart: datetime
    arrive: datetime
    from_seq: str = ''
    to_seq: str = ''
    seat_types: str = ''
    seats: dict = field(default_factory=dict)
    sale_open: bool = True
    prices: dict = field(default_factory=dict)
    fare_checked: str | None = None
    checked_at: str | None = None
    fare_error: str | None = None

    @property
    def key(self):
        return (self.train_no, self.from_code, self.to_code, self.depart.date().isoformat())

    @property
    def duration(self):
        return int((self.arrive - self.depart).total_seconds() / 60)


@dataclass
class SearchOptions:
    origin: str
    destination: str
    earliest: datetime
    latest: datetime
    depart_days: int = 1
    mode: str = 'balanced'
    seats: list = field(default_factory=lambda: list(DEFAULT_SEATS))
    min_transfer: int = 45
    max_transfer: int = 360
    allow_cross_station: bool = False
    min_cross_station: int = 120
    min_sleep: int = 360
    avoid_early: bool = True
    early_policy: str = 'prefer'
    budget: int | None = None
    via: str = ''
    via_code: str = ''
    via_mode: str = 'prefer'
    exclude: str = ''
    include_unavailable: bool = False
    hubs: int = 4
    stay_min: int | None = None
    stay_max: int | None = None

    @classmethod
    def parse(cls, payload, now=None):
        now = now or now_cn()
        try:
            earliest = datetime.fromisoformat(str(payload['earliest']))
            latest = datetime.fromisoformat(str(payload['latest']))
            if earliest.tzinfo or latest.tzinfo:
                raise InputError('请使用中国当地时间，不附加时区偏移。')
            if earliest.date() < now.date():
                raise InputError('出发日期不能早于今天。')
            sale_end = now.date() + timedelta(days=14)
            if earliest.date() > sale_end:
                raise InputError('请选择未来 15 天内的出发日期（含今天）。')
            if latest <= earliest or latest - earliest > timedelta(days=5):
                raise InputError('最晚到达须晚于最早出发，且时间窗口不超过 5 天。')
            origin, destination = str(payload['origin']).strip(), str(payload['destination']).strip()
            if not origin or not destination or len(origin) > 30 or len(destination) > 30:
                raise InputError('请填写有效的出发地和目的地。')
            if origin == destination:
                raise InputError('出发地和目的地不能相同。')
            seats = payload.get('seats', DEFAULT_SEATS)
            if not isinstance(seats, list) or not seats or any(s not in SEATS for s in seats):
                raise InputError('请至少选择一种支持的席别。')
            def integer(key, default, low, high):
                value = int(payload.get(key, default))
                if not low <= value <= high:
                    raise InputError(f'{key} 超出允许范围。')
                return value
            mode = payload.get('mode', 'balanced')
            if mode not in ('balanced', 'price', 'duration', 'arrival', 'sleeper'):
                raise InputError('未知的排序模式。')
            budget_raw = payload.get('budget')
            budget = None if budget_raw in ('', None) else round(float(budget_raw) * 100)
            if budget is not None and not 0 < budget <= 10000000:
                raise InputError('预算须为大于零的金额。')
            transfer_min = integer('min_transfer', 45, 20, 600)
            transfer_max = integer('max_transfer', 360, 20, 1440)
            if transfer_max < transfer_min:
                raise InputError('最长换乘时间不能短于最短换乘时间。')
            via_mode = payload.get('via_mode', 'prefer')
            if via_mode not in ('prefer', 'must'):
                raise InputError('未知的中转城市模式。')
            # Old callers that explicitly set avoid_early=True retain their
            # strict hard constraint. New UI makes strict/prefer/allow explicit.
            early_policy = payload.get('early_policy', 'strict' if payload.get('avoid_early') is True else 'prefer')
            if early_policy not in ('prefer', 'strict', 'allow'):
                raise InputError('未知的凌晨换乘偏好。')
            def boolean(key, default=False):
                value = payload.get(key, default)
                if type(value) is not bool:
                    raise InputError(f'{key} 必须为布尔值。')
                return value
            stay_min = None if payload.get('stay_min') in ('', None) else integer('stay_min', 0, 0, 1440)
            stay_max = None if payload.get('stay_max') in ('', None) else integer('stay_max', 0, 0, 1440)
            if stay_min is not None and stay_max is not None and stay_min > stay_max:
                raise InputError('最短停留不能长于最长停留。')
            return cls(origin=origin, destination=destination, earliest=earliest, latest=latest,
                depart_days=integer('depart_days', 1, 1, 3), mode=mode, seats=list(dict.fromkeys(seats)),
                min_transfer=transfer_min, max_transfer=transfer_max,
                allow_cross_station=boolean('allow_cross_station'),
                min_sleep=integer('min_sleep', 360, 60, 600), avoid_early=boolean('avoid_early', True), early_policy=early_policy,
                budget=budget, via=str(payload.get('via', '')).strip()[:30], via_mode=via_mode,
                exclude=str(payload.get('exclude', '')).strip()[:200],
                include_unavailable=boolean('include_unavailable'), hubs=integer('hubs', 4, 2, 8),
                stay_min=stay_min, stay_max=stay_max)
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            if isinstance(exc, InputError):
                raise
            raise InputError('查询参数无效，请检查日期、时间和数字。') from exc


def best_seat(segment, options):
    candidates = []
    for code in options.seats:
        state = availability(segment.seats.get(code)) if segment.sale_open else 'not_on_sale'
        if state != 'available' and not options.include_unavailable:
            continue
        price = segment.prices.get(code)
        candidates.append((code, state, price))
    # Always prefer confirmed purchasable seats, then known execution prices.
    candidates.sort(key=lambda x: (x[1] != 'available', x[2] is None, x[2] if x[2] is not None else 10**9))
    return candidates


def route_from_segments(segments, options, city_of, source):
    first, last = segments[0], segments[-1]
    if first.depart < options.earliest or last.arrive > options.latest:
        return None
    if first.depart.date() >= options.earliest.date() + timedelta(days=options.depart_days):
        return None
    excluded = {x.strip() for x in re.split(r'[,，、\s]+', options.exclude) if x.strip()}
    wait, cross, via = 0, False, ''
    early_transfer = False
    if len(segments) == 2:
        a, b = segments
        if a.train_no == b.train_no:
            return None  # Same-train seat changes are outside this edition.
        via = city_of(a.to_code)
        if via in excluded or a.to_name in excluded or b.from_name in excluded:
            return None
        if options.via and options.via_mode == 'must' and options.via not in (via, a.to_name, b.from_name):
            return None
        if options.via_code and options.via_mode == 'must' and options.via_code not in (a.to_code, b.from_code):
            return None
        cross = a.to_code != b.from_code
        if cross and (not options.allow_cross_station or city_of(b.from_code) != via):
            return None
        wait = int((b.depart - a.arrive).total_seconds() / 60)
        required = max(options.min_transfer, options.min_cross_station if cross else 0, options.stay_min or 0)
        maximum = options.stay_max if options.stay_max is not None else options.max_transfer
        if wait < required or wait > maximum:
            return None
        early_transfer = touches_early_hours(a.arrive, b.depart)
        if options.avoid_early and options.early_policy == 'strict' and early_transfer:
            return None
    elif options.via and options.via_mode == 'must':
        return None
    choices = [best_seat(segment, options) for segment in segments]
    if any(not group for group in choices):
        return None
    # A sleeper preference may require a more expensive seat on a night leg.
    selected = [group[0] for group in choices]
    if options.mode == 'sleeper':
        possible = []
        for index, (segment, group) in enumerate(zip(segments, choices)):
            overlap = night_overlap(segment.depart, segment.arrive)
            if overlap >= options.min_sleep:
                for seat in group:
                    if seat[0] in SLEEPERS:
                        hypothetical = selected.copy()
                        hypothetical[index] = seat
                        if all(s[2] is not None for s in hypothetical):
                            cost = sum(s[2] for s in hypothetical)
                        else:
                            cost = 10**9
                        possible.append((any(s[1] != 'available' for s in hypothetical), cost, -overlap, hypothetical))
        if not possible:
            return None
        selected = min(possible, key=lambda p: p[:3])[3]
    rest = max((night_overlap(s.depart, s.arrive) if seat[0] in SLEEPERS else 0 for s, seat in zip(segments, selected)), default=0)
    early_exception = False
    if early_transfer and options.avoid_early and options.early_policy == 'prefer':
        # Soft preference: a well-rested night arrival just before six can
        # connect after six, provided the wait is short and no station change.
        # Midnight waits and short night journeys are still excluded.
        a, b = segments
        early_exception = (not cross and a.arrive.date() > a.depart.date()
            and a.arrive.hour >= 5 and b.depart.hour >= 6
            and a.arrive.date() == b.depart.date() and wait <= 120
            and selected[0][0] in SLEEPERS
            and night_overlap(a.depart, a.arrive) >= options.min_sleep)
        if not early_exception:
            return None
    priced = all(seat[2] is not None for seat in selected)
    total = sum(seat[2] for seat in selected) if priced else None
    if options.budget is not None and (total is None or total > options.budget):
        return None
    available = all(seat[1] == 'available' for seat in selected)
    legs = []
    for segment, (seat, status, price) in zip(segments, selected):
        legs.append({'train': segment.code, 'train_no': segment.train_no,
            'from': segment.from_name, 'to': segment.to_name, 'from_code': segment.from_code, 'to_code': segment.to_code,
            'depart': iso(segment.depart), 'arrive': iso(segment.arrive), 'duration': segment.duration,
            'seat': SEATS[seat][0], 'seat_code': seat, 'availability': status,
            'stock': segment.seats.get(seat, ''), 'price_fen': price,
            'fare_checked_at': segment.fare_checked, 'inventory_checked_at': segment.checked_at,
            'fare_error': segment.fare_error})
    duration = int((last.arrive - first.depart).total_seconds() / 60)
    day = daylight_minutes(first.depart, last.arrive)
    key = '|'.join(str(s.key) for s in segments) + str([s[0] for s in selected])
    reasons = []
    if len(segments) == 1:
        reasons.append('直达，无需换乘')
    else:
        reasons.append(('同城换站' if cross else '同站换乘') + f'，预留 {wait} 分钟')
    if rest:
        reasons.append(f'夜间卧铺可休息窗口 {rest // 60}小时{rest % 60 or ""}{"分" if rest % 60 else ""}')
    if options.via and via == options.via:
        reasons.append('经过你选择的中转城市')
    if early_exception:
        reasons.append('卧铺清晨 6 点前到站，接续车 6 点后出发；请确认能接受早起')
    if not available:
        reasons.append('包含无票或待核实路段，不保证可以买齐')
    if not priced:
        reasons.append('部分查询票价待确认，不参与精确价格排名')
    return {'id': hashlib.sha256(key.encode()).hexdigest()[:16], 'segments': legs,
        'depart': iso(first.depart), 'arrive': iso(last.arrive), 'duration': duration,
        'on_train': sum(s.duration for s in segments), 'wait': wait, 'via': via,
        'cross_station': cross, 'price_fen': total, 'priced': priced, 'available': available,
        'early_arrival': early_exception,
        'rest_minutes': rest, 'daytime_minutes': day, 'source': source, 'reasons': reasons}


def rank_routes(routes, mode):
    def key(route):
        prefix = (not route['available'], not route['priced'])
        price = route['price_fen'] if route['price_fen'] is not None else 10**9
        if mode == 'price':
            return prefix + (price, route['duration'])
        if mode == 'duration':
            return prefix + (route['duration'], price)
        if mode == 'arrival':
            return prefix + (route['arrive'], price)
        if mode == 'sleeper':
            # The route filter already guarantees the requested rest duration.
            # Extra minutes of sleep should not outweigh hours of daytime travel.
            return prefix + (route['daytime_minutes'], route['arrive'], price, route['duration'], -route['rest_minutes'])
        return prefix + (route['duration'] + route['wait'] * .3 + (90 if route['cross_station'] else 0) + price / 100 * .7 - min(route['rest_minutes'], 480) * .15, price)
    return sorted(routes, key=key)
