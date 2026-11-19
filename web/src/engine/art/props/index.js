// Engine-scale prop art (32x16 tile), for props the classic art does not have (and the stall, redrawn at engine scale:
// raster.js prefers this registry over the classic props-art.js).
// Each module: { name, frames, extent(p, style) -> [x0,y0,x1,y1] about the foot point, draw(g, p, fx, fy, t, lit, style) }.
import * as tree from './tree.js';
import * as pine from './pine.js';
import * as sapling from './sapling.js';
import * as bush from './bush.js';
import * as rock from './rock.js';
import * as hedge from './hedge.js';
import * as cart from './cart.js';
import * as barrel from './barrel.js';
import * as crate from './crate.js';
import * as laundry from './laundry.js';
import * as scarecrow from './scarecrow.js';
import * as lamp from './lamp.js';
import * as banner from './banner.js';
import * as railing from './railing.js';
import * as pier from './pier.js';
import * as bollard from './bollard.js';
import * as skiff from './skiff.js';
import * as hay from './hay.js';
import * as crops from './crops.js';
import * as clover from './clover.js';
import * as sunflower from './sunflower.js';
import * as flowers from './flowers.js';
import * as vessel from './vessel.js';
import * as tug from './tug.js';
import * as rowboat from './rowboat.js';
import * as lighthouse from './lighthouse.js';
import * as beacon from './beacon.js';
import * as warehouse from './warehouse.js';
import * as crane from './crane.js';
import * as buoy from './buoy.js';
import * as quay from './quay.js';
import * as breakwater from './breakwater.js';
import * as crates from './crates.js';
import * as stall from './stall.js';
export const PROPS = Object.freeze({ tree, pine, sapling, bush, rock, hedge, cart, barrel, crate, laundry, scarecrow, lamp, banner, railing, pier, bollard, skiff, hay, crops, clover, sunflower, flowers, vessel, tug, rowboat, lighthouse, beacon, warehouse, crane, buoy, quay, breakwater, crates, stall });
