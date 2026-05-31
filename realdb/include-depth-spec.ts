import { parseSpec } from '../src/index.js'
// Chain: Comment → Post → Author → City → Country → Continent
// From Comment, ?include=post.author.city.country = depth 4 (≤ default), and
// post.author.city.country.continent = depth 5 (> default → 400).
export const spec = parseSpec({
  version: '1.0.0',
  name: 'include-depth-e2e',
  resources: [
    { name: 'Continent', fields: { name: { type: 'string', required: true } } },
    { name: 'Country', fields: { name: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'Continent', field: 'continentId', required: true }] },
    { name: 'City', fields: { name: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'Country', field: 'countryId', required: true }] },
    { name: 'Author', fields: { name: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'City', field: 'cityId', required: true }] },
    { name: 'Post', fields: { title: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'Author', field: 'authorId', required: true }] },
    { name: 'Comment', fields: { text: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'Post', field: 'postId', required: true }] },
  ],
})
