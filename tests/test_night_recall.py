"""Regression for night gateways, shared inventory columns and shortlist recall.

Actual date/seat samples are fixtures only; production code contains no special
route/train overrides. Clock is fixed so these tests remain valid after sale day.
"""
import json
from dataclasses import replace
from datetime import datetime
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from domain import SEATS, Segment, SearchOptions, route_from_segments, rank_routes
from planner import Planner, choose_hubs, shortlist_routes
from provider import Stations, decode_inventory

DATA=json.loads((Path(__file__).parent/'fixtures/night_gateway_20261018.json').read_text(encoding='utf-8'))


def load_segment(raw):
    raw=dict(raw)
    parts=['']*56
    parts[35]=raw['seat_types']
    for code in ('O','M','9','3','4','6','F','1','WZ'):
        parts[SEATS[code][1]]=raw['seats'].get(code,'')
    raw['seats']=decode_inventory(parts)
    raw['depart']=datetime.fromisoformat(raw['depart'])
    raw['arrive']=datetime.fromisoformat(raw['arrive'])
    return Segment(**raw)


class NightRecall(unittest.TestCase):
    def setUp(self):
        self.stations=Stations()
        self.firsts=[load_segment(x) for x in DATA['first_legs']]
        self.seconds=[load_segment(x) for x in DATA['second_legs']]
        self.options=SearchOptions('深圳','南京',datetime(2026,10,18,18),datetime(2026,10,19,14),mode='sleeper')

    def test_dynamic_sleeper_inventory_uses_advertised_product(self):
        first=self.firsts[0]
        self.assertEqual(first.seats['F'],'有')
        self.assertEqual(first.seats['4'],'')
        result=route_from_segments([first,self.seconds[0]],self.options,self.stations.city,'fixture')
        self.assertIsNotNone(result)
        self.assertTrue(result['priced'])
        self.assertEqual(result['segments'][0]['seat_code'],'F')

    def test_soft_early_preference_retains_restful_morning_connection(self):
        result=route_from_segments([self.firsts[0],self.seconds[0]],self.options,self.stations.city,'fixture')
        self.assertIsNotNone(result)
        self.assertTrue(result['early_arrival'])
        self.assertTrue(any('6 点前到站' in r for r in result['reasons']))

    def test_strict_early_constraint_is_never_relaxed(self):
        result=route_from_segments([self.firsts[0],self.seconds[0]],replace(self.options,early_policy='strict'),self.stations.city,'fixture')
        self.assertIsNone(result)
        payload={'origin':'深圳','destination':'南京','earliest':'2026-10-18T18:00','latest':'2026-10-19T14:00','avoid_early':True}
        self.assertEqual(SearchOptions.parse(payload,datetime(2026,10,17)).early_policy,'strict')

    def test_no_ticket_train_does_not_become_available(self):
        missing=next(s for s in self.firsts if s.code=='D942')
        result=route_from_segments([missing,self.seconds[0]],self.options,self.stations.city,'fixture')
        self.assertIsNone(result)

    def test_near_destination_gateways_are_not_lost_to_corridor_hubs(self):
        self.assertIn('杭州',choose_hubs('深圳','南京',4))
        self.assertIn('石家庄',choose_hubs('广州','北京',4))
        self.assertIn('合肥',choose_hubs('北京','上海',4))

    def test_shortlist_covers_first_trains_before_onward_duplicates(self):
        items=[]
        for first in self.firsts[:2]:
            for second in self.seconds:
                result=route_from_segments([first,second],self.options,self.stations.city,'fixture')
                if result:items.append(([first,second],'fixture',result))
        self.assertGreater(len(items),2)
        chosen=shortlist_routes([],items,limit=2)
        self.assertEqual({item[0][0].code for item in chosen},{'D932','D936'})

    def test_enough_rest_does_not_reward_tiny_sleep_gain_over_daytime_cost(self):
        base={'id':'restful','available':True,'priced':True,'price_fen':73000,
            'rest_minutes':479,'daytime_minutes':129,'arrive':'2026-10-19T08:19','duration':729}
        longer=dict(base,id='slightly-more-rest',rest_minutes=486,daytime_minutes=135,arrive='2026-10-19T08:56',price_fen=82100,duration=735)
        self.assertEqual(rank_routes([longer,base],'sleeper')[0]['id'],'restful')

    def test_end_to_end_discovers_both_trains_without_specifying_gateway(self):
        all_segments=self.firsts+self.seconds
        stations=self.stations
        class Replay:
            def tickets(self,a,b,date,budget):
                budget.take()
                return [replace(s) for s in all_segments if s.depart.date().isoformat()==date and
                    (s.from_code==a['code'] if a['exact'] else stations.city(s.from_code)==a['city']) and
                    (s.to_code==b['code'] if b['exact'] else stations.city(s.to_code)==b['city'])]
            def transfers(self,*args):return [],0
            def fares(self,s,budget):
                budget.take()
                # Fixture contains already captured execution fares.
        with patch('planner.now_cn',return_value=datetime(2026,10,17,23)):
            result=Planner(Replay(),stations).search(self.options)
        codes={s['train'] for route in result['routes'] for s in route['segments']}
        self.assertTrue({'D932','D936'}<=codes)
        self.assertNotIn('D942',codes)
        priced_codes={s['train'] for route in result['routes'] if route['priced'] for s in route['segments']}
        self.assertTrue({'D932','D936'}<=priced_codes)


if __name__=='__main__':unittest.main()
