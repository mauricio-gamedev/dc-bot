import { CATEGORY_BLUEPRINT, ROLE_BLUEPRINT } from '../src/core/blueprint.js';
import { IDENTITY_ROLE_NAMES } from '../src/core/identityDisplay.js';

function assertUnique(values, label) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size) {
    throw new Error(`${label} duplicado(s): ${[...duplicates].join(', ')}`);
  }
}

assertUnique(CATEGORY_BLUEPRINT.map((category) => category.name), 'Categoria');
assertUnique(CATEGORY_BLUEPRINT.flatMap((category) => category.channels.map((channel) => channel.name)), 'Canal gerenciado');
assertUnique(ROLE_BLUEPRINT.map((role) => role.name), 'Cargo base');
assertUnique(IDENTITY_ROLE_NAMES, 'Cargo cosmético');

const overlap = IDENTITY_ROLE_NAMES.filter((name) => ROLE_BLUEPRINT.some((role) => role.name === name));
if (overlap.length) throw new Error(`Cargo cosmético conflita com cargo base: ${overlap.join(', ')}`);

const commandChannel = CATEGORY_BLUEPRINT
  .flatMap((category) => category.channels)
  .find((channel) => channel.name === '🤖・comandos');

if (!commandChannel) throw new Error('Canal público de comandos não está definido.');
if (!commandChannel.readOnly) throw new Error('Canal público de comandos precisa ser somente leitura.');

console.log('community config ok');
