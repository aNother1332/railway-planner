"""Build local map assets from pinned, attributed public datasets.

Development only: pip install shapely pypinyin. See data/MAP_SOURCES.md.
Inputs are prepared in --source; generated assets need no Python packages.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def build(source, output):
    from shapely.geometry import shape, mapping, Point
    from shapely.ops import unary_union
    from shapely.strtree import STRtree
    from pypinyin import lazy_pinyin
    from provider import Stations

    def read(name):
        return json.loads((source / name).read_text(encoding='utf-8'))

    def save(name, value):
        output.mkdir(parents=True, exist_ok=True)
        (output / name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

    def short(name):
        return re.sub(r'(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|市|省)$', '', name)

    def roman(name):
        name = re.sub(r'(?:各族)?(?:自治县|自治旗|县|区|市|旗)$', '', name)
        return ''.join(lazy_pinyin(name)).lower().replace('ü', 'u')

    def english(name):
        if re.search('[\u4e00-\u9fff]',name):
            return roman(name)
        name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
        name = re.sub(r'\b(county|city|district|autonomous|banner|new|urban|suburban)\b', '', name)
        return re.sub('[^a-z]', '', name)

    provinces = read('admin-provinces.json')
    province_names = {p['code']: short(p['name']) for p in provinces}
    cities = {x['code']: x for x in read('admin-cities.json')}
    areas = read('admin-areas.json')
    direct_features=read('osm-city-regions.json')['features']
    direct_shapes={f['properties']['id']:shape(f['geometry']).buffer(0) for f in direct_features}
    direct_ids=list(direct_shapes)
    direct_tree=STRtree([direct_shapes[i] for i in direct_ids])
    county_features=read('CHN-ADM3.json')['features']
    land_shapes=[shape(f['geometry']).buffer(0) for f in county_features]
    land_tree=STRtree(land_shapes)
    def land_display(geometry):
        # Full OSM administrative relations can include territorial waters.
        # Keep them for membership, but shade land only in the station picker.
        local=[land_shapes[int(i)] for i in land_tree.query(geometry)]
        return geometry.intersection(unary_union(local)).buffer(0)
    def city_parent(area):
        return area['provinceCode']+'01' if area['provinceCode'] in {'11','12','31','50'} else area['cityCode']
    # Cities such as Jiayuguan have no county layer in the division table.
    # Their city-level boundary can still match a synthetic lookup entry.
    for city in cities.values():
        if not any(a['cityCode']==city['code'] for a in areas) and city['name']!='市辖区':
            areas.append({'code':city['code']+'00','name':city['name'],'cityCode':city['code'],'provinceCode':city['provinceCode']})
    by_province = defaultdict(list)
    for a in areas:
        by_province[a['provinceCode']].append(a)
    names = ['海南','台湾','广西','福建','云南','贵州','江西','湖南','浙江','上海','重庆','湖北','四川','安徽','江苏','河南','西藏','山东','青海','宁夏','陕西','天津','山西','北京','甘肃','河北','辽宁','吉林','新疆','内蒙古','黑龙江','澳门','香港','广东']
    names_to_code = {v:k for k,v in province_names.items()}
    names_to_code.update({'台湾':'71','香港':'81','澳门':'82'})
    province_shapes = []
    features = []
    for f, name in zip(read('CHN-ADM1.json')['features'], names):
        g = shape(f['geometry']).buffer(0)
        municipal=names_to_code[name]+'01'
        if municipal in direct_shapes and names_to_code[name] in {'11','12','31','50'}:
            g=land_display(direct_shapes[municipal])
        province_shapes.append((names_to_code[name], g))
        features.append({'type':'Feature', 'properties':{'id':names_to_code[name], 'name':name}, 'geometry':mapping(g.simplify(.002 if municipal in direct_shapes else .018, preserve_topology=True))})
    save('provinces.json', {'type':'FeatureCollection','features':features})

    # Full city relations determine city extent and station membership. Old
    # counties serve only as optional drill-down details, never city shells.
    english_aliases=defaultdict(set)
    for relation in read('osm-admin-index.json')['elements']:
        tags=relation.get('tags',{})
        cn=tags.get('name:zh-Hans') or tags.get('name:zh') or tags.get('name','')
        en=tags.get('name:en','')
        if cn and en:
            english_aliases[cn].add(english(en))
    matched = []
    skipped = []
    for f,g in zip(county_features,land_shapes):
        if g.is_empty:
            continue
        point = g.representative_point()
        direct_hits=[direct_ids[int(i)] for i in direct_tree.query(point) if direct_shapes[direct_ids[int(i)]].covers(point)]
        province = direct_hits[0][:2] if len(direct_hits)==1 else next((code for code,p in province_shapes if p.covers(point)), None)
        key = english(f['properties']['shapeName'])
        candidates = [a for a in by_province[province] if roman(a['name']) == key or key in english_aliases[a['name']]]
        if not candidates:
            candidates = [a for a in by_province[province] if len(key)>3 and roman(a['name']).startswith(key)]
        if len(candidates)>1 and len(direct_hits)==1:
            candidates=[a for a in candidates if (a['code'] if '直辖' in cities[a['cityCode']]['name'] else city_parent(a))==direct_hits[0]]
        if len(candidates) != 1:
            skipped.append(f['properties']['shapeName'])
            continue
        a = candidates[0]
        parent = cities[a['cityCode']]
        # Province-administered counties have a synthetic city parent in the
        # source. Give them an independent map entry, preserving county rank.
        independent = '直辖' in parent['name']
        identity = a['code'] if independent else city_parent(a)
        label = short(a['name']) if independent else (province_names[a['provinceCode']] if a['provinceCode'] in {'11','12','31','50'} else short(parent['name']))
        if identity in direct_shapes:
            g=g.intersection(direct_shapes[identity]).buffer(0)
            if g.is_empty:continue
        matched.append((identity, label, a, g, independent))

    groups = defaultdict(list)
    for row in matched:
        groups[row[0]].append(row)
    area_by_code={a['code']:a for a in areas}
    for f in direct_features:
        identity=f['properties']['id']
        if identity in groups:continue
        independent=len(identity)==6
        if independent:
            a=area_by_code[identity];label=short(a['name'])
        else:
            parent=cities[identity]
            a={'code':identity+'00','name':parent['name'],'cityCode':identity,'provinceCode':parent['provinceCode']}
            label=province_names[a['provinceCode']] if parent['name']=='市辖区' else short(parent['name'])
        groups[identity].append((identity,label,a,direct_shapes[identity],independent))
    map_cities, city_shapes, region_features = [], [], []
    county_shapes = []
    capitals = {'北京','天津','上海','重庆','石家庄','太原','呼和浩特','沈阳','长春','哈尔滨','南京','杭州','合肥','福州','南昌','济南','郑州','武汉','长沙','广州','南宁','海口','成都','贵阳','昆明','拉萨','西安','兰州','西宁','银川','乌鲁木齐'}
    for identity, rows in groups.items():
        _,label,a,_,independent = rows[0]
        g = direct_shapes.get(identity)
        if g is None:
            g=unary_union([r[3] for r in rows]).buffer(0)
        display=land_display(g)
        visible=display if not display.is_empty else g
        p = visible.representative_point()
        level = 3 if independent else (1 if a['provinceCode'] in {'11','12','31','50'} else 2)
        city = {'id':identity,'name':label,'province':province_names[a['provinceCode']], 'level':level,'priority':0 if label in capitals or label in {'深圳','苏州','青岛','大连','厦门'} else (2 if independent else 1), 'coord':[round(p.x,5),round(p.y,5)],'bounds':[round(x,5) for x in visible.bounds],'boundarySource':'OSM relation' if identity in direct_shapes else 'historical county detail'}
        map_cities.append(city)
        city_shapes.append((identity,g))
        relation_meta=next((f['properties'] for f in direct_features if f['properties']['id']==identity),{})
        region_features.append({'type':'Feature','properties':{'id':identity,'name':label,'osmId':relation_meta.get('osmId'),'source':city['boundarySource'],'display':'land'},'geometry':mapping(display.simplify(.001, preserve_topology=True))})
        for _,_,area,county,_ in rows:
            if not independent and area['name'].endswith('市') and area['name']!=cities[area['cityCode']]['name']:
                cp=county.representative_point()
                county_shapes.append((area['code'],county))
                map_cities.append({'id':area['code'],'name':short(area['name']),'province':province_names[a['provinceCode']],'parentId':identity,'parentName':label,'level':3,'priority':2,'coord':[round(cp.x,5),round(cp.y,5)],'bounds':[round(x,5) for x in county.bounds]})
                region_features.append({'type':'Feature','properties':{'id':area['code'],'name':short(area['name']),'parentId':identity},'geometry':mapping(county.simplify(.008,preserve_topology=True))})
    save('regions.json', {'type':'FeatureCollection','features':region_features})

    stations = Stations()
    def station_name(value):
        value = re.sub(r'\s|[（）()]', '', value or '')
        return re.sub(r'(火车站|铁路车站|铁路站|站)$', '', value)

    aliases = defaultdict(list)
    for s in stations.items:
        aliases[s['name']].append(s)
    candidates = defaultdict(list)
    for e in read('osm-stations.json').get('elements', []):
        t = e.get('tags', {})
        if t.get('station') in {'subway','light_rail'} or t.get('subway')=='yes' or t.get('disused')=='yes' or t.get('railway')!='station':
            continue
        c = e.get('center', e)
        if 'lon' not in c or 'lat' not in c:
            continue
        keys = set()
        for k in ['name:zh','name:zh-Hans','name','alt_name','official_name','short_name']:
            keys.update(station_name(n) for n in t.get(k,'').split(';') if n)
        for k in keys:
            for s in aliases.get(k, []):
                candidates[s['code']].append((e,t,[c['lon'],c['lat']]))
    result = []
    unmatched = []
    for s in stations.items:
        options = candidates.get(s['code'], [])
        # Collapse OSM station building/node duplicates nearby. Resolve
        # same-name stations by explicit telecode, otherwise with geography
        # of the railway city where that city has an administrative match.
        preferred = [o for o in options if s['code'] in {o[1].get('ref'),o[1].get('ref:crs'),o[1].get('ref:CN:railway')}]
        if preferred:
            options = preferred
        if not options:
            unmatched.append(s['code']);continue
        primary = [o for o in options if s['name'] in {station_name(o[1].get(k,'')) for k in ['name:zh','name:zh-Hans','name','official_name']}]
        if primary and not preferred:
            options=primary
        if len(options)>1:
            city_ids = [c['id'] for c in map_cities if c['name']==s['city']]
            if len(city_ids)==1:
                region = next(g for i,g in city_shapes+county_shapes if i==city_ids[0])
                options = sorted(options, key=lambda o: region.distance(Point(o[2])))
                if not preferred and region.distance(Point(options[0][2]))>.7:
                    unmatched.append(s['code']);continue
            elif max(Point(options[0][2]).distance(Point(o[2])) for o in options)>.15:
                unmatched.append(s['code']);continue
        e,t,coord = options[0]
        point = Point(coord)
        members = [(i,g) for i,g in city_shapes if g.covers(point)]
        city_id = min(members, key=lambda x:x[1].area)[0] if members else None
        county_id=next((i for i,g in county_shapes if g.covers(point)),None)
        result.append({'code':s['code'],'name':s['name'],'query':s['name']+'站','railCity':s['city'],'cityId':city_id,'countyId':county_id,'coord':[round(x,6) for x in coord],'osm':str(e['type'])+'/'+str(e['id'])})
    counts = defaultdict(int)
    # Some no-county cities have no polygon in the historical boundary file.
    # Still expose their verified station positions, without drawing a made-up
    # administrative boundary. Preserve the weaker membership provenance.
    for admin in cities.values():
        if admin['code'] in {c['id'] for c in map_cities} or '直辖' in admin['name'] or admin['name']=='市辖区':
            continue
        label=short(admin['name'])
        group=[s for s in result if s['railCity']==label]
        if not group:
            continue
        anchor=next((s for s in group if s['name']==label),group[0])
        xs=[s['coord'][0] for s in group];ys=[s['coord'][1] for s in group]
        map_cities.append({'id':admin['code'],'name':label,'province':province_names[admin['provinceCode']],'level':2,'priority':1,'coord':anchor['coord'],'bounds':[min(xs)-.12,min(ys)-.12,max(xs)+.12,max(ys)+.12],'boundaryAvailable':False})
        for s in group:
            if not s['cityId']:
                s['cityId']=admin['code'];s['membership']='railway-group'
    # Hong Kong is absent from the mainland statistical tree but has a 12306
    # station and a province-level shape in the pinned boundary dataset.
    hk=[s for s in result if s['railCity']=='香港']
    if hk:
        hg=next(g for i,g in province_shapes if i=='81')
        map_cities.append({'id':'81','name':'香港','province':'香港','level':1,'priority':1,'coord':hk[0]['coord'],'bounds':list(hg.bounds),'special':True})
        region_features.append({'type':'Feature','properties':{'id':'81','name':'香港'},'geometry':mapping(hg)})
        for s in hk:s['cityId']='81'
        save('regions.json', {'type':'FeatureCollection','features':region_features})
    for s in result:
        counts[s['cityId']]+=1
        if s['countyId']:counts[s['countyId']]+=1
    # Keep cities without mapped stations visible for geography, with a
    # clear unavailable state. No guessed station coordinates.
    for c in map_cities:
        c['stationCount'] = counts[c['id']]
        # Anchor city dots at the matching central railway station when
        # available, rather than at an arbitrary interior polygon point.
        anchor=next((s for s in result if s['name']==c['name'] and (s['cityId']==c['id'] or s['countyId']==c['id'])),None)
        if anchor:c['coord']=anchor['coord']
    save('cities.json', map_cities)
    priorities = json.loads((ROOT/'data'/'station_display_priority.json').read_text(encoding='utf-8'))['priorities']
    for station in result:
        station['displayPriority'] = priorities.get(station['name'], 2)
    save('stations.json', result)
    save('coverage.json', {'date':'2026-10-18','stationTotal':len(stations.items),'mappedStations':len(result),'cities':len(map_cities),'matchedDivisions':len(matched),'unmatchedBoundaries':len(skipped),'stationsWithoutAdminRegion':sum(not s['cityId'] for s in result),'unmappedCodes':unmatched,'directCityBoundaries':len(direct_shapes),'boundaryYear':'OSM 2026-10-18','boundaryNote':'城市边界：OSM 2026-10-18 快照；县级细节：2017；全国轮廓：2019（直辖市已更新）','stationSource':'OpenStreetMap','stationLicense':'ODbL-1.0','adminTreeYear':2023})
    print(json.dumps({'cities':len(map_cities),'mappedStations':len(result),'totalStations':len(stations.items),'matchedDivisions':len(matched),'skipped':len(skipped)}, ensure_ascii=False))


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,required=True)
    p.add_argument('--output',type=Path,default=ROOT/'web'/'map-data')
    args=p.parse_args()
    build(args.source,args.output)
