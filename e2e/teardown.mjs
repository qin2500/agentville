// Playwright may SIGKILL the webServer, so its fixture home is removed here rather than in serve.mjs.
import fs from 'node:fs'
import { HOME } from './helpers.mjs'

export default () => fs.rmSync(HOME, { recursive: true, force: true })
