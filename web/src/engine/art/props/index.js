// Engine-scale prop art (32x16 tile), for props the classic art does not have. OWNER: A1 (lead wires modules here).
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
export const PROPS = Object.freeze({ tree, pine, sapling, bush, rock, hedge, cart, barrel, crate, laundry, scarecrow, lamp, banner, railing });
