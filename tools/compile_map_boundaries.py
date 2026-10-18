"""Compile complete OSM administrative relations into local city boundaries.

Development only (shapely). Input is the selected relation index and cached
Overpass `out geom` batches; runtime never calls Overpass. No name/pinyin
inference is used to assemble a city from county fragments.
"""
import argparse
import json
from pathlib import Path


def compile_boundaries(source,partial=False):
    from shapely.geometry import LineString, mapping
    from shapely.geometry.polygon import orient
    from shapely.ops import polygonize_full, unary_union

    targets=json.loads((source/'osm-admin-selected.json').read_text(encoding='utf-8'))
    relations={}
    for path in sorted(source.glob('osm-admin-geometry*.json')):
        for relation in json.loads(path.read_text(encoding='utf-8'))['elements']:
            relations[relation['id']]=relation
    missing=[t['name'] for t in targets if t['osmId'] not in relations]
    if missing and not partial:
        raise ValueError(f'Incomplete source: {len(missing)} missing relations, including {missing[:5]}')
    if partial:
        targets=[t for t in targets if t['osmId'] in relations]
    features=[]
    failures=[]
    for target in targets:
        relation=relations[target['osmId']]
        rings={'outer':[],'inner':[]}
        def collect(current,inverted=False,ancestors=frozenset()):
            if current['id'] in ancestors:
                failures.append((target['name'],'cyclic boundary relation',current['id']));return
            ancestors=ancestors|{current['id']}
            for member in current['members']:
                role=member.get('role') or 'outer'
                if role not in rings:continue
                flip=inverted ^ (role=='inner')
                if member['type']=='relation' and member['ref'] in relations:
                    collect(relations[member['ref']],flip,ancestors);continue
                if member['type']!='way' or not member.get('geometry'):
                    failures.append((target['name'],'unsupported/missing boundary member',member['ref']));continue
                coords=[(p['lon'],p['lat']) for p in member['geometry'] if p and 'lon' in p]
                if len(coords)<2 or len(coords)!=len(member['geometry']):
                    failures.append((target['name'],'incomplete way',member['ref']));continue
                rings['inner' if flip else 'outer'].append(LineString(coords))
        collect(relation)
        outer,cuts,dangles,invalid=polygonize_full(unary_union(rings['outer']))
        if outer.is_empty or cuts.length+dangles.length+invalid.length>1e-7:
            failures.append((target['name'],'unclosed outer boundary',round(cuts.length+dangles.length+invalid.length,6)))
            continue
        geometry=unary_union(list(outer.geoms))
        if rings['inner']:
            inner,cuts,dangles,invalid=polygonize_full(unary_union(rings['inner']))
            if cuts.length+dangles.length+invalid.length>1e-7:
                failures.append((target['name'],'unclosed inner boundary',''))
                continue
            geometry=geometry.difference(unary_union(list(inner.geoms)))
        geometry=geometry.buffer(0)
        if geometry.is_empty or not geometry.is_valid:
            failures.append((target['name'],'invalid polygon',''))
            continue
        # Clockwise exterior rings are required by d3.geoPath's spherical
        # convention. Keep accuracy here; simplify display assets separately.
        if geometry.geom_type=='Polygon':
            geometry=orient(geometry,sign=-1)
        else:
            from shapely.geometry import MultiPolygon
            geometry=MultiPolygon([orient(p,sign=-1) for p in geometry.geoms])
        features.append({'type':'Feature','properties':{'id':target['id'],'name':target['name'],'osmId':target['osmId'],'source':'OpenStreetMap','snapshot':'2026-10-18'},'geometry':mapping(geometry)})
    if failures:
        raise ValueError('Boundary integrity errors: '+str(failures[:20]))
    result={'type':'FeatureCollection','features':features}
    (source/('osm-city-regions.partial.json' if partial else 'osm-city-regions.json')).write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    print(f'Compiled {len(features)} complete administrative boundaries')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--partial',action='store_true',help='Validate cached relations only; writes a separate partial file')
    args=parser.parse_args()
    compile_boundaries(args.source,args.partial)
