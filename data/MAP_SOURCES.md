# Local map sources and licenses

Prepared 2026-10-18. All map assets are local; ticket queries require a network
connection. No Amap/Baidu/Google tiles, POI exports or DataV boundaries are used.

## Boundaries

City extent now comes from **369 complete OpenStreetMap administrative
relations**, retrieved 2026-10-18. The explicit relation/code manifest is
`data/map_boundary_relations.json` (ODbL 1.0). Names and administrative levels
are matched to complete cities, municipalities and province-administered
counties, instead of reconstructing their borders from county names.

Sources: Overpass administrative relation index and geometry; where that service
returned transient errors, the first-party OSM API `relation/{id}/full.json`.
All inputs are cached during development. The runtime never accesses either API.
`tools/compile_map_boundaries.py` joins way/node geometry, recursively resolves
outer member relations, preserves real inner rings, and rejects missing or
unclosed boundaries. Generated region features retain the source relation ID.

Province outlines originally come from geoBoundaries gbOpen, pinned upstream
commit `9469f09`, CHN/ADM1 represented year 2019 (Public Domain). Its 34 shapes
are retained except the four municipalities, updated to their complete OSM city
shapes. The upstream mislabelled `Guangzhou Province` is displayed as 广东.

County drill-down details use geoBoundaries CHN/ADM3, represented year 2017,
source Lee Beryman/OpenStreetMap, ODbL 1.0. They are matched using Chinese names,
OSM English aliases and geography of the complete parent city, then clipped to
that parent. Missing county details cannot remove part of the parent city.
This fixes same-name districts (Nanjing/Xuzhou Gulou), alternate readings
(Minhang), and obsolete county configurations. Full administrative relations may include territorial waters. City shading and
camera framing use a separate land mask formed from all original 2017 county
polygons, regardless of their names; this prevents the earlier name-matching
holes from reappearing and avoids shading large sea sectors. City membership
continues to use the complete administrative geometry. The historical land mask
can lag coastline/reclamation changes.

Display simplification is approximately 0.001 degrees for cities; station
membership uses unsimplified city geometry. These community snapshots are not an official boundary survey.

<https://www.openstreetmap.org/copyright>
<https://www.geoboundaries.org/api.html>
<https://github.com/wmgeolab/geoBoundaries>

Hong Kong uses its province-level shape and 12306 station. Historical county
outlines, the 2023 hierarchy and the OSM snapshot have different dates; remaining
unknown/ambiguous station membership is explicitly shown instead of guessed.

## Administrative tree

modood/Administrative-divisions-of-China `dist/provinces.json`, `cities.json`,
`areas.json`, statistical divisions 2023. Downloaded 2026-10-18; upstream commit
`c49d495b40ac73eb1a66f6eeae5f8fd10696f035`.

<https://github.com/modood/Administrative-divisions-of-China>

License WTFPL v2; original notice: `web/vendor/ADMIN-DATA-LICENSE.txt`.
County-level cities retain parent IDs; province-administered counties under
synthetic parents become independent entries while retaining county rank.
Municipalities are flattened. Fiscal/provincial pilot arrangements do not
override this tree.

## Station coordinates

© OpenStreetMap contributors. ODbL 1.0.
<https://www.openstreetmap.org/copyright>
<https://opendatacommons.org/licenses/odbl/1-0/>

Downloaded 2026-10-18 from Overpass API:

```overpass
[out:json][timeout:100];
nwr[railway=station](18,73,54,135);
out center tags;
```

Only matches to the 12306 station snapshot are bundled. Subway/light rail and
disused tags are excluded. Current primary names are preferred to alternate
names; old names alone are not matched. Duplicates are resolved by supplied
telecodes or name/geography checks. Each output retains its OSM object ID.
Coordinates use WGS84 throughout, not mixed with GCJ-02/BD-09. Station polygons
use the Overpass bounding-box center.

OSM name matching does not guarantee current passenger service. The existing
12306 query verifies train/seat availability. Missing coordinates are never
replaced by a city center. Exact counts are in `web/map-data/coverage.json`.

The adapted/combined database in `web/map-data/` and its relation manifest is made available under ODbL
1.0; attribution and database license must accompany redistribution. This does
not license application source code. Bundled JSON supplies the adapted database
in machine-readable form; `tools/build_map_data.py` records transformations.

## Renderer

D3 v7.9.0, © Mike Bostock, ISC license; local `web/vendor/d3.min.js`, full notice
in `web/vendor/D3-LICENSE.txt`. <https://github.com/d3/d3/tree/v7.9.0>

## Rebuild (development only)

Runtime remains Python standard library only. Preparing new map snapshots needs
separate developer packages `shapely` and `pypinyin`. Place these raw inputs in a
temporary directory:

- `CHN-ADM1.json`, `CHN-ADM3.json`: above pinned geoBoundaries files; download
  actual Git LFS content via `media.githubusercontent.com`, not pointer files.
- `admin-provinces.json`, `admin-cities.json`, `admin-areas.json`: corresponding
  `dist/` files in the pinned administrative tree repository.
- `osm-stations.json`: response to the Overpass query above.
- `osm-admin-index.json`: cached `out tags` index of administrative relations
  at levels 4, 5 and 6 in the China area (for localized name aliases).
- `osm-admin-selected.json`: copy of the bundled relation manifest.
- `osm-admin-geometry*.json`: cached relation `out geom` responses. For OSM API
  full responses, attach each member way's node coordinates as its `geometry`.
  Include nested outer/inner relation geometry; do not include only subareas.

```powershell
python tools/compile_map_boundaries.py --source path/to/raw-sources
python tools/build_map_data.py --source path/to/raw-sources
```

Run browser map checks and inspect geographic samples before accepting a new
snapshot. Match renamed stations by railway code as well as name; do not assume
a former name still denotes the same code.


### 客运显示优先级（2026-10-18）

`station_display_priority.json` 保存人工维护的客运展示规则。南京、南京南、深圳北、深圳和福田根据产品要求重点突出，其余代表性枢纽取自现有 `planner.HUBS` 清单。未知站按普通展示，保留选择能力。

深圳枢纽功能参考深圳市交通运输局《深圳市综合立体交通》相关规划：[政府公布文档](https://www.sz.gov.cn/attachment/1/1499/1499907/11659163.pdf)。其中区分主要和辅助枢纽，福田为辅助功能；本工具将其重点突出是客运界面选择，不表示官方等级变化。未将规划中的未运营车站自动加入铁路站点列表。铁路车站等级涉及客货运、编组等指标，目前未取得全国统一、完整且可核实的最新等级表，因此不提供未经核实的官方等级标注。
