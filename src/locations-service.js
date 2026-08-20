const brazilianStates = [
  ['AC', 'Acre'], ['AL', 'Alagoas'], ['AP', 'Amapá'], ['AM', 'Amazonas'],
  ['BA', 'Bahia'], ['CE', 'Ceará'], ['DF', 'Distrito Federal'], ['ES', 'Espírito Santo'],
  ['GO', 'Goiás'], ['MA', 'Maranhão'], ['MT', 'Mato Grosso'], ['MS', 'Mato Grosso do Sul'],
  ['MG', 'Minas Gerais'], ['PA', 'Pará'], ['PB', 'Paraíba'], ['PR', 'Paraná'],
  ['PE', 'Pernambuco'], ['PI', 'Piauí'], ['RJ', 'Rio de Janeiro'], ['RN', 'Rio Grande do Norte'],
  ['RS', 'Rio Grande do Sul'], ['RO', 'Rondônia'], ['RR', 'Roraima'], ['SC', 'Santa Catarina'],
  ['SP', 'São Paulo'], ['SE', 'Sergipe'], ['TO', 'Tocantins']
].map(([code, name]) => ({ code, name }));

const stateCodes = new Set(brazilianStates.map((state) => state.code));
const municipalityCache = new Map();

async function municipalitiesForState(state) {
  const code = String(state || '').toUpperCase();
  if (!stateCodes.has(code)) throw new Error('UF inválida');
  if (municipalityCache.has(code)) return municipalityCache.get(code);

  const response = await fetch(
    `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${code}/municipios`,
    { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } }
  );
  if (!response.ok) throw new Error(`IBGE respondeu com status ${response.status}`);

  const municipalities = (await response.json())
    .map((municipality) => ({ code: String(municipality.id), name: municipality.nome }))
    .sort((first, second) => first.name.localeCompare(second.name, 'pt-BR'));
  municipalityCache.set(code, municipalities);
  return municipalities;
}

module.exports = { brazilianStates, stateCodes, municipalitiesForState };