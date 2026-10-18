/* Geographic regressions use the shipped projection library and database.
   No GIS packages, online APIs or mutable upstream fixtures are required. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const d3=require('../web/vendor/d3.min.js');
const read=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../web/map-data',name+'.json'),'utf8'));
const regions=new Map(read('regions').features.map(f=>[f.properties.id,f]));
const stations=read('stations');
const inside=(id,coord)=>d3.geoContains(regions.get(id),coord);
assert.equal(inside('3201',[118.76,32.08]),true,'Nanjing Gulou must not be a hole');
assert.equal(inside('3201',[118.65,32.08]),true,'Nanjing includes Jiangbei');
for(const [id,names] of [['3101',['上海虹桥','上海南','上海松江']],['4403',['深圳','深圳北','深圳东','深圳坪山','福田','深圳机场','深圳机场北']]]){
  for(const name of names){
    const s=stations.find(s=>s.name===name);assert.ok(s,'Missing station fixture: '+name);
    assert.equal(inside(id,s.coord),true,name+' must be geographically inside its city');
    assert.equal(s.cityId,id,name+' must appear as a local station');
  }
}
assert.equal(inside('3101',stations.find(s=>s.code==='KNH').coord),false,'Shanghai must not absorb Kunshan South');
assert.equal(inside('3101',[122,31.1]),false,'City shading must not paint the offshore administrative sea sector as land');
assert.equal(inside('3201',[118.507,31.687]),false,'Nanjing must not absorb Maanshan');
assert.equal(inside('4403',[113.752,23.02]),false,'Shenzhen must not absorb central Dongguan');
for(const id of ['3201','3101','4403']){
  assert.equal(regions.get(id).properties.source,'OSM relation');
  assert.ok(regions.get(id).properties.osmId,'Boundary provenance is required');
}
console.log('REGIONS PASSED: Nanjing Gulou/Jiangbei; Shanghai Hongqiao/South/Songjiang; Shenzhen stations; neighboring cities remain outside');
