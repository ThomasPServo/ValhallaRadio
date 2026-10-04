import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import {
  prettyRoad, classifyIncident, parseChp, parseWzdx, wzdxFeedsFor, marketAreas, relevantHeadline, isMajorRoad, cleanText, incidentFeedsFor,
} from '../server/feeds/traffic.js';
import { mapMetno, metConditions, sunTimes, timezoneFor } from '../server/feeds/weather.js';
import { trafficBrief, weatherBrief, zoneLine } from '../server/ai/dj.js';
import { zonedEpoch, parseWallTime, marketZones, applyMarketTimezone } from '../server/util/time.js';

const travis = { name: 'Travis County, Texas, US', lat: 30.29, lon: -97.76, state: 'Texas', countryCode: 'US', kind: 'county', bbox: [-98.17, 30.02, -97.37, 30.63] };
const la = { name: 'Los Angeles, California, US', lat: 34.05, lon: -118.24, state: 'California', countryCode: 'US', kind: 'city' };

test('road text reads like a traffic reporter would say it', () => {
  assert.equal(prettyRoad('IH 35 SVRD NB / E RUNDBERG LN'), 'I-35 service road northbound at E Rundberg Ln');
  assert.equal(prettyRoad('Eagle Lakes Rd Ofr / I80 W'), 'Eagle Lakes Rd off-ramp at I-80 westbound');
  assert.equal(prettyRoad('US101 S Jno Grand Ave'), 'US 101 southbound just north of Grand Ave');
  assert.equal(prettyRoad('W Us 290 Hwy Svrd Wb & S Mopac Expy Svrd Sb'), 'W US 290 Hwy service road westbound at S MoPac Expy service road southbound');
  assert.equal(prettyRoad('GUERRERO ST \\ ROSA PARKS LN'), 'Guerrero St at Rosa Parks Ln');
  assert.equal(prettyRoad('SR99 N'), 'Highway 99 northbound');
});

test('major roads vs side streets', () => {
  for (const r of ['I-35', 'US 183', 'Highway 71', 'Loop 360', 'Sam Houston Tollway', 'MoPac Expy', 'Golden Gate Bridge']) assert.ok(isMajorRoad(r), r);
  for (const r of ['Bridge Point Pkwy', 'Parkwood Rd', 'E 14th St', 'Barton Springs Rd']) assert.ok(!isMajorRoad(r), r);
});

test('dispatch call types map to radio incident types, police noise is dropped', () => {
  assert.deepEqual(classifyIncident('1179-Trfc Collision-1141 Enrt'), { type: 'crash with injuries', severity: 3 });
  assert.equal(classifyIncident('1182-Trfc Collision-No Inj').type, 'minor crash');
  assert.equal(classifyIncident('SIG Alert').severity, 3);
  assert.equal(classifyIncident('CFIRE-Car Fire').type, 'vehicle fire');
  assert.equal(classifyIncident('Crash Urgent').severity, 3);
  assert.equal(classifyIncident('Crash Service').type, 'minor crash');
  assert.equal(classifyIncident('MVI Freeway').type, 'crash on the freeway');
  assert.equal(classifyIncident('major accident freeway').type, 'major crash on the freeway');
  assert.equal(classifyIncident('Stalled Vehicle').type, 'stalled vehicle');
  assert.equal(classifyIncident('LOOSE LIVESTOCK').type, 'animals on the road');
  for (const noise of ['TRAFFIC STOP', 'TRAF VIOLATION CITE', 'N / HZRD TRFC VIOL', 'MZP-Assist CT with Maintenance', '46 - CIT', 'DAEF-Dist Armed Encounter Foot']) {
    assert.equal(classifyIncident(noise), null, noise);
  }
});

const CHP = `<?xml version="1.0" ?><State><Center ID = "LAHB"><Dispatch ID = "LACC">
  <Log ID = "261003LA1329">
    <LogTime>"Oct  3 2026  5:29PM"</LogTime>
    <LogType>"1179-Trfc Collision-1141 Enrt"</LogType>
    <Location>"SR134 W / Lankershim Blvd"</Location>
    <Area>"WEST VALLEY"</Area>
    <LATLON>"34148000:118365000"</LATLON>
    <LogDetails><details><DetailTime>"Oct  3 2026  5:30PM"</DetailTime><IncidentDetail>"[2] 2 VEHS BLKG #3 LN"</IncidentDetail></details></LogDetails>
  </Log>
  <Log ID = "261003LA1330">
    <LogTime>"Oct  3 2026  5:31PM"</LogTime>
    <LogType>"MZP-Assist CT with Maintenance"</LogType>
    <Location>"I5 N / Colorado St"</Location>
    <LATLON>"34140000:118270000"</LATLON>
  </Log>
</Dispatch></Center></State>`;

test('CHP media feed: incidents with time, place, lanes and coordinates', () => {
  const r = parseChp(CHP);
  assert.equal(r.length, 1, 'maintenance assists are not traffic');
  const i = r[0];
  assert.equal(i.type, 'crash with injuries');
  assert.equal(i.where, 'Highway 134 westbound at Lankershim Blvd');
  assert.equal(i.road, 'Highway 134 westbound');
  assert.equal(i.lanes, 'blocking lanes');
  assert.equal(i.place, 'West Valley');
  assert.equal(i.lat, 34.148);
  assert.equal(i.lon, -118.365);
  assert.equal(new Date(i.at).toISOString(), '2026-10-04T00:29:00.000Z'); // 5:29 PM PDT
});

const H = 3600_000;
const NOW = Date.parse('2026-10-04T01:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const feature = (props, coords = [[-97.74, 30.3], [-97.73, 30.31]]) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props });
const wz = (o) => feature({
  core_details: { event_type: 'work-zone', road_names: [o.road], direction: o.dir || 'northbound', description: o.desc || 'Bridge work' },
  start_date: iso(o.start), end_date: iso(o.end), vehicle_impact: o.impact || 'some-lanes-closed',
  beginning_cross_street: o.from || '', ending_cross_street: o.to || '',
}, o.coords);

test('WZDx: active and tonight\'s closures on major roads in the market, merged across directions', () => {
  const areas = marketAreas([travis]);
  const doc = {
    features: [
      wz({ road: 'IH 35', dir: 'northbound', impact: 'all-lanes-closed', start: NOW - H, end: NOW + 5 * H, from: 'Parmer Ln', to: 'Wells Branch Pkwy' }),
      wz({ road: 'IH 35', dir: 'southbound', impact: 'all-lanes-closed', start: NOW - H, end: NOW + 5 * H, from: 'Parmer Ln', to: 'Wells Branch Pkwy' }),
      wz({ road: 'US 183', impact: 'some-lanes-closed', start: NOW + 3 * H, end: NOW + 9 * H, from: 'Burnet Rd' }), // tonight
      wz({ road: 'US 290', start: NOW + 30 * H, end: NOW + 40 * H }), // too far ahead
      wz({ road: 'Loop 1', start: NOW - 10 * H, end: NOW - H }), // over
      wz({ road: 'Pasadena Dr', impact: 'some-lanes-closed', start: NOW - 400 * 24 * H, end: NOW + 90 * 24 * H }), // side-street permit
      wz({ road: 'IH 10', start: NOW - H, end: NOW + H, coords: [[-95.36, 29.76], [-95.35, 29.77]] }), // Houston: outside
      wz({ road: 'Loop 360', impact: 'all-lanes-open', start: NOW - H, end: NOW + H }),
    ],
  };
  const r = parseWzdx(doc, { areas, now: NOW, source: 'Test DOT' });
  assert.deepEqual(r.map((c) => c.road), ['I-35', 'US 183']);
  assert.equal(r[0].direction, 'both directions');
  assert.equal(r[0].impact, 'all lanes closed');
  assert.equal(r[0].cross, 'between Parmer Ln and Wells Branch Pkwy');
  assert.equal(r[0].area, 'Travis County');
  assert.ok(r[1].upcoming);
  // a fresh full closure of a side street counts from a state feed, not from a city permit feed
  const side = { features: [wz({ road: 'Barton Springs Rd', impact: 'all-lanes-closed', start: NOW - H, end: NOW + 4 * H })] };
  assert.equal(parseWzdx(side, { areas, now: NOW }).length, 1);
  assert.equal(parseWzdx(side, { areas, now: NOW, local: true }).length, 0);
});

test('WZDx feed discovery: statewide by state, city feeds only nearby', () => {
  const feeds = [
    { id: 'txdot', name: 'Texas DOT', state: 'texas', local: false },
    { id: 'austin', name: 'City of Austin', state: 'texas', local: true, lat: 30.27, lon: -97.74 },
    { id: 'wisdot', name: 'Wisconsin DOT', state: 'wisconsin', local: false },
    { id: 'ne', name: 'NHDOT/VTAOT/MEDOT', state: 'new hampshire, vermont, maine', local: false },
  ];
  assert.deepEqual(wzdxFeedsFor(feeds, [travis]).map((f) => f.id), ['txdot', 'austin']);
  assert.deepEqual(wzdxFeedsFor(feeds, [{ name: 'Dallas, Texas, US', state: 'Texas', lat: 32.78, lon: -96.8 }]).map((f) => f.id), ['txdot']);
  assert.deepEqual(wzdxFeedsFor(feeds, [{ name: 'Burlington, Vermont, US', state: 'Vermont', lat: 44.47, lon: -73.2 }]).map((f) => f.id), ['ne']);
});

test('incident feeds are picked from the market', () => {
  assert.deepEqual(incidentFeedsFor([travis]).map((f) => f.id), ['austin']);
  assert.deepEqual(incidentFeedsFor([la]).map((f) => f.id), ['chp']);
  assert.deepEqual(incidentFeedsFor([{ name: 'San Francisco, California, US', state: 'California', lat: 37.78, lon: -122.42 }]).map((f) => f.id), ['chp', 'sf']);
  assert.deepEqual(incidentFeedsFor([{ name: 'Boise, Idaho, US', state: 'Idaho', lat: 43.6, lon: -116.2 }]), []);
});

test('headline filter keeps local traffic news only', () => {
  const places = ['Seattle', 'Washington'];
  assert.ok(relevantHeadline('Crash blocks two lanes of I-5 near Northgate', places));
  assert.ok(relevantHeadline('Seattle bridge closure snarls evening commute', places));
  assert.ok(!relevantHeadline('A road crash on a highway in Kenya killed at least 17 people', places));
  assert.ok(!relevantHeadline('Seattle man charged after crash', places));
  assert.ok(!relevantHeadline('Washington airport air traffic controllers', places));
  assert.ok(!relevantHeadline('Seahawks beat Chargers in Seattle', places));
});

test('descriptions lose permit boilerplate and contacts', () => {
  const t = cleanText('*** Original work dates May 02 *** Lane closure for bridge joint repair. CONTACT: Jo Smith - jo@x.gov - 512-555-0100');
  assert.equal(t, 'Lane closure for bridge joint repair.');
});

test('traffic brief for the DJ prompt', () => {
  const tr = {
    incidents: [{ type: 'crash with injuries', where: 'I-35 northbound at Rundberg Ln', area: 'Travis County', lanes: 'blocking lanes', at: NOW - 12 * 60000 }],
    closures: [{ road: 'US 183', direction: 'southbound', impact: 'lane closures', cross: 'at Burnet Rd', upcoming: true, from: NOW + 3 * H, area: 'Travis County' }],
    headlines: [],
  };
  const b = trafficBrief(tr, { now: NOW, timeZone: 'America/Chicago' });
  assert.match(b, /crash with injuries — I-35 northbound at Rundberg Ln \(Travis County\), blocking lanes, reported 12 min ago/);
  assert.match(b, /US 183 southbound: lane closures at Burnet Rd, starting 11 PM \(Travis County\)/);
  assert.match(trafficBrief({ incidents: [], closures: [], headlines: [] }), /no incidents or closures/);
});

// ------------------------------------------------------------------ weather

test('MET Norway symbols in plain English', () => {
  assert.equal(metConditions('clearsky_day'), 'sunny');
  assert.equal(metConditions('clearsky_night'), 'clear');
  assert.equal(metConditions('lightrainshowers_day'), 'light rain showers');
  assert.equal(metConditions('heavysnow'), 'heavy snow');
  assert.equal(metConditions('rainandthunder'), 'thunderstorms');
  assert.equal(metConditions('partlycloudy_night'), 'partly cloudy');
});

test('MET Norway forecast maps to the station weather shape (imperial)', () => {
  const start = Date.parse('2026-10-04T10:00:00Z'); // 11:00 in London
  const timeseries = Array.from({ length: 40 }, (_, i) => ({
    time: new Date(start + i * H).toISOString(),
    data: {
      instant: { details: { air_temperature: 10 + Math.round(5 * Math.sin(i / 4)), relative_humidity: 80, wind_speed: 5, apparent_air_temperature: 9 } },
      next_1_hours: { summary: { symbol_code: i === 3 ? 'rain' : 'cloudy' }, details: { precipitation_amount: i === 3 ? 2.54 : 0 } },
    },
  }));
  const w = mapMetno({ properties: { timeseries } }, { imperial: true, timeZone: 'Europe/London', now: start });
  assert.equal(w.current.temp, 50);
  assert.equal(w.current.feelsLike, 48);
  assert.equal(w.current.wind, 11); // 5 m/s in mph
  assert.equal(w.today.name, 'Today');
  assert.equal(w.today.conditions, 'rain');
  assert.ok(w.today.high >= w.today.low);
  assert.equal(w.today.precipTotal, 0.1);
  assert.equal(w.next12.length, 12);
  assert.equal(w.next12[0].time, '11:00');
  assert.match(weatherBrief({ location: 'London', units: { temp: '°F', wind: 'mph' }, ...w }), /today: rain, high \d+, low \d+, about 0.1 of precipitation/);
});

test('sunrise and sunset computed locally', () => {
  const s = sunTimes(30.2672, -97.7431, new Date('2026-10-04T15:00:00Z'), 'America/Chicago');
  const near = (d, hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const local = new Date(d.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    return Math.abs(local.getHours() * 60 + local.getMinutes() - (h * 60 + m)) <= 3;
  };
  assert.ok(near(s.sunrise, '07:26'), s.sunrise.toISOString());
  assert.ok(near(s.sunset, '19:13'), s.sunset.toISOString());
  assert.deepEqual(sunTimes(78.2, 15.6, new Date('2026-06-21T12:00:00Z'), 'Arctic/Longyearbyen'), { sunrise: null, sunset: null }); // midnight sun
});

test('time zones are looked up offline', () => {
  assert.equal(timezoneFor(30.27, -97.74), 'America/Chicago');
  assert.equal(timezoneFor(31.76, -106.49), 'America/Denver'); // El Paso
  assert.equal(timezoneFor(51.5, -0.12), 'Europe/London');
});

// ------------------------------------------------------------------ time zones across the market

test('wall-clock times in a zone, across DST changes', () => {
  assert.equal(new Date(zonedEpoch('America/Los_Angeles', 2026, 10, 3, 17, 29)).toISOString(), '2026-10-04T00:29:00.000Z');
  assert.equal(new Date(parseWallTime('2026-03-08T03:30:00', 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(new Date(parseWallTime('2026-01-15T09:00:00.000', 'Europe/Berlin')).toISOString(), '2026-01-15T08:00:00.000Z');
});

test('market zones and the station clock following the primary location', () => {
  const station = {
    timezone: 'UTC',
    timezoneMode: 'auto',
    market: { locations: [
      { name: 'Lubbock, Texas, US', timezone: 'America/Chicago' },
      { name: 'Midland, Texas, US', timezone: 'America/Chicago' },
      { name: 'El Paso, Texas, US', timezone: 'America/Denver' },
    ] },
  };
  const zones = marketZones(station, new Date('2026-10-04T00:20:00Z'));
  assert.deepEqual(zones.map((z) => [z.tz, z.label, z.places]), [['America/Chicago', 'CDT', ['Lubbock', 'Midland']], ['America/Denver', 'MDT', ['El Paso']]]);
  assert.equal(applyMarketTimezone(station), true);
  assert.equal(station.timezone, 'America/Chicago');
  assert.equal(applyMarketTimezone(station), false, 'no change the second time');
  station.timezoneMode = 'manual';
  station.market.locations.unshift({ name: 'Denver', timezone: 'America/Denver' });
  assert.equal(applyMarketTimezone(station), false, 'manual zone is kept');
  assert.equal(station.timezone, 'America/Chicago');
  const line = zoneLine({ ...station, market: { locations: station.market.locations.slice(1) } }, Date.parse('2026-10-04T00:20:00Z'));
  assert.match(line, /7:20 PM CDT in Lubbock and Midland; 6:20 PM MDT in El Paso/);
  assert.equal(zoneLine({ market: { locations: [{ name: 'Austin', timezone: 'America/Chicago' }] } }), '');
});
