import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { generatePrismaSchema } from '../src/index.js'
import { spec } from './softdelete-spec.js'
const out = resolve(process.cwd(), 'realdb/prisma/softdelete.prisma')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, generatePrismaSchema(spec))
console.log('wrote', out)
