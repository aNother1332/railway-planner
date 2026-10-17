import sys
import unittest
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from domain import (InputError, SearchOptions, Segment, money_fen, night_overlap,
                    touches_early_hours, route_from_segments, rank_routes)
from provider import Budget, QueryLimit, RailClient, Stations
from planner import Planner


def dt(value):
    return datetime.fromisoformat(value)


class RouteRules(unittest.TestCase):
    def setUp(self):
        self.options = SearchOptions('北京', '上海', dt('2026-10-18T18:00'), dt('2026-10-20T18:00'))
        self.first = Segment('N1', 'Z1', 'BJP', 'ZZF', '北京', '郑州',
            dt('2026-10-18T21:00'), dt('2026-10-19T07:00'), seats={'3':'有','O':'有'},
            prices={'3':20000,'O':10000})
        self.second = Segment('N2', 'G2', 'ZZF', 'SHH', '郑州', '上海',
            dt('2026-10-19T08:00'), dt('2026-10-19T12:00'), seats={'O':'2'}, prices={'O':15000})
        self.city = lambda code: {'BJP':'北京','ZZF':'郑州','ZAF':'郑州','SHH':'上海'}.get(code, code)

    def route(self, options=None, legs=None):
        return route_from_segments(legs or [self.first,self.second], options or self.options, self.city, 'test')

    def test_cross_date_connection_and_exact_sum(self):
        route = self.route(replace(self.options,mode='sleeper'))
        self.assertEqual(route['price_fen'], 35000)
        self.assertEqual(route['duration'], 15*60)
        self.assertEqual(route['wait'], 60)
        self.assertEqual(route['rest_minutes'], 9*60)
        self.assertEqual(route['segments'][1]['depart'], '2026-10-19T08:00')

    def test_sleeper_mode_does_not_choose_cheaper_seat(self):
        route = self.route(replace(self.options,mode='sleeper'))
        self.assertEqual(route['segments'][0]['seat_code'],'3')
        self.assertEqual(self.route()['segments'][0]['seat_code'],'O')

    def test_insufficient_continuous_night_is_rejected(self):
        short = replace(self.first, depart=dt('2026-10-19T02:00'), arrive=dt('2026-10-19T05:00'))
        self.assertIsNone(self.route(replace(self.options,mode='sleeper',avoid_early=False),[short,self.second]))

    def test_hard_arrival_budget_and_city_constraints(self):
        self.assertIsNone(self.route(replace(self.options,latest=dt('2026-10-19T11:00'))))
        self.assertIsNone(self.route(replace(self.options,budget=24000)))
        self.assertIsNone(self.route(replace(self.options,via='武汉',via_mode='must')))
        self.assertIsNone(self.route(replace(self.options,exclude='郑州')))
        self.assertIsNotNone(self.route(replace(self.options,via='郑州',via_mode='must')))

    def test_unknown_price_never_becomes_zero_or_fits_budget(self):
        unknown=replace(self.second,prices={})
        route=self.route(legs=[self.first,unknown])
        self.assertIsNone(route['price_fen'])
        self.assertFalse(route['priced'])
        self.assertIsNone(self.route(replace(self.options,budget=999999),[self.first,unknown]))

    def test_unavailable_seats_are_opt_in(self):
        no_ticket=replace(self.second,seats={'O':'无'})
        self.assertIsNone(self.route(legs=[self.first,no_ticket]))
        self.assertFalse(self.route(replace(self.options,include_unavailable=True),[self.first,no_ticket])['available'])

    def test_cross_station_requires_permission_and_two_hours(self):
        cross=replace(self.second,from_code='ZAF')
        self.assertIsNone(self.route(legs=[self.first,cross]))
        self.assertIsNone(self.route(replace(self.options,allow_cross_station=True),[self.first,cross]))
        cross=replace(cross,depart=dt('2026-10-19T09:00'))
        self.assertIsNotNone(self.route(replace(self.options,allow_cross_station=True),[self.first,cross]))

    def test_overnight_transfer_is_rejected(self):
        first=replace(self.first,arrive=dt('2026-10-18T23:30'))
        second=replace(self.second,depart=dt('2026-10-19T06:30'))
        options=replace(self.options,max_transfer=500)
        self.assertIsNone(self.route(options,[first,second]))
        self.assertIsNotNone(self.route(replace(options,avoid_early=False),[first,second]))

    def test_stay_range_replaces_default_max_wait(self):
        second=replace(self.second,depart=dt('2026-10-19T15:00'),arrive=dt('2026-10-19T19:00'))
        self.assertIsNone(self.route(legs=[self.first,second]))
        self.assertIsNotNone(self.route(replace(self.options,stay_min=240,stay_max=600),[self.first,second]))

    def test_time_and_money_helpers(self):
        self.assertEqual(night_overlap(dt('2026-10-18T21:00'),dt('2026-10-19T07:00')),540)
        self.assertTrue(touches_early_hours(dt('2026-10-18T23:50'),dt('2026-10-19T06:10')))
        self.assertFalse(touches_early_hours(dt('2026-10-19T06:00'),dt('2026-10-19T07:00')))
        self.assertEqual(money_fen('¥626.0'),62600)
        self.assertEqual(money_fen('￥283.5'),28350)
        self.assertIsNone(money_fen('07950'))

    def test_earliest_arrival_differs_from_shortest_duration(self):
        a=self.route()
        b=dict(a,id='b',duration=a['duration']-60,arrive='2026-10-19T14:00')
        self.assertEqual(rank_routes([a,b],'duration')[0]['id'],'b')
        self.assertEqual(rank_routes([b,a],'arrival')[0]['id'],a['id'])

    def test_exact_via_station_cannot_match_its_city_sibling(self):
        self.assertIsNone(self.route(replace(self.options,via='郑州',via_code='ZAF',via_mode='must')))
        self.assertIsNotNone(self.route(replace(self.options,via='郑州',via_code='ZZF',via_mode='must')))

    def test_departure_date_range_is_hard_constraint(self):
        late=replace(self.first,depart=dt('2026-10-19T21:00'),arrive=dt('2026-10-20T07:00'))
        end=replace(self.second,depart=dt('2026-10-20T08:00'),arrive=dt('2026-10-20T12:00'))
        self.assertIsNone(self.route(legs=[late,end]))
        self.assertIsNotNone(self.route(replace(self.options,depart_days=2),[late,end]))


class DataAdapter(unittest.TestCase):
    def setUp(self):
        self.stations=Stations()

    def test_city_and_station_are_different(self):
        self.assertFalse(self.stations.resolve('北京')['exact'])
        self.assertTrue(self.stations.resolve('北京站')['exact'])
        self.assertEqual(self.stations.resolve('上海虹桥站')['code'],'AOH')
        with self.assertRaises(InputError):
            self.stations.resolve('不存在的城市')

    def test_query_budget_and_cancel(self):
        budget=Budget(maximum=1)
        budget.take()
        with self.assertRaises(QueryLimit):budget.take()
        budget=Budget();budget.cancel.set()
        with self.assertRaises(QueryLimit):budget.check()

    def test_fares_use_execution_endpoint_and_explicit_units(self):
        client=RailClient(self.stations)
        calls=[]
        def cached(path,params,budget,ttl=45):
            calls.append((path,params))
            return {'data':{'O':'¥626.0','A3':'¥283.5','M':'12720'},'_queried_at':'2026-10-17T22:30'}
        client.cached=cached
        segment=Segment('INTERNAL','G1','VNP','AOH','北京南','上海虹桥',dt('2026-10-18T08:00'),dt('2026-10-18T12:30'),'01','04','OM')
        client.fares(segment,Budget())
        self.assertEqual(calls[0][0],'/otn/leftTicket/queryTicketPrice')
        self.assertEqual(calls[0][1]['train_date'],'2026-10-18')
        self.assertEqual(segment.prices['O'],62600)
        self.assertNotIn('M',segment.prices)

    def test_date_window_validation(self):
        payload={'origin':'北京','destination':'上海','earliest':'2026-10-18T18:00','latest':'2026-10-19T18:00'}
        self.assertEqual(SearchOptions.parse(payload,dt('2026-10-17T12:00')).depart_days,1)
        with self.assertRaises(InputError):SearchOptions.parse(dict(payload,earliest='2026-10-16T18:00'),dt('2026-10-17T12:00'))
        with self.assertRaises(InputError):SearchOptions.parse(dict(payload,latest='2026-11-10T18:00'),dt('2026-10-17T12:00'))
        with self.assertRaises(InputError):SearchOptions.parse(dict(payload,seats=[]),dt('2026-10-17T12:00'))

    def test_same_query_is_cached_across_searches(self):
        client=RailClient(self.stations)
        calls=[]
        client._request=lambda *args: calls.append(args) or {'status':True}
        a,b=Budget(),Budget()
        client.cached('/read',{'date':'2026-10-18'},a)
        client.cached('/read',{'date':'2026-10-18'},b)
        self.assertEqual(len(calls),1)
        self.assertEqual(b.cache_hits,1)


class SearchIntegration(unittest.TestCase):
    def setUp(self):
        from domain import now_cn
        self.stations=Stations()
        tomorrow=now_cn().date()+timedelta(days=1)
        departure=datetime.combine(tomorrow,datetime.min.time()).replace(hour=21,minute=35)
        self.a=Segment('NIGHT','Z285','BXP','GBZ','北京西','桂林北',departure,departure+timedelta(hours=19,minutes=1),seats={'3':'有'})
        self.b=Segment('DAY','G1505','GBZ','LZZ','桂林北','柳州',self.a.arrive+timedelta(minutes=50),self.a.arrive+timedelta(minutes=122),seats={'O':'有'})
        self.options=SearchOptions('北京','柳州',departure-timedelta(hours=3),departure+timedelta(days=2),mode='sleeper',via='桂林',via_mode='must',hubs=2)
        first,second=self.a,self.b
        class FakeClient:
            def tickets(inner,a,b,date,budget):
                budget.take()
                return [s for s in [first,second] if s.depart.date().isoformat()==date and
                    (s.from_code==a['code'] or (not a['exact'] and a['city']==self.stations.city(s.from_code))) and
                    (s.to_code==b['code'] or (not b['exact'] and b['city']==self.stations.city(s.to_code)))]
            def transfers(inner,*args):return [('GBZ','GBZ')],1
            def fares(inner,segment,budget):
                budget.take()
                segment.prices={'3':39900} if segment.train_no=='NIGHT' else {'O':5050}
        self.planner=Planner(FakeClient(),self.stations)

    def test_full_search_combines_dates_and_execution_prices(self):
        result=self.planner.search(self.options)
        self.assertEqual(len(result['routes']),1)
        self.assertEqual(result['routes'][0]['price_fen'],44950)
        self.assertEqual(result['routes'][0]['wait'],50)
        self.assertEqual(result['highlights']['sleeper'],result['routes'][0]['id'])

    def test_exact_station_autocomplete_remains_exact(self):
        result=self.planner.search(replace(self.options,via='桂林北站'))
        self.assertEqual(len(result['routes']),1)
        result=self.planner.search(replace(self.options,via='桂林站'))
        self.assertEqual(result['routes'],[])

    def test_no_route_can_bypass_a_hard_budget(self):
        result=self.planner.search(replace(self.options,budget=40000))
        self.assertEqual(result['routes'],[])


if __name__=='__main__':
    unittest.main()
