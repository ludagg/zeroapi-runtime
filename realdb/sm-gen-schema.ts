import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { generatePrismaSchema } from '../src/index.js'
import { spec } from './sm-spec.js'

const out = resolve(process.cwd(), 'realdb/prisma/sm.prisma')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, generatePrismaSchema(spec))
console.log('wrote', out)
