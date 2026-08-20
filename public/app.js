const menuButton = document.querySelector('.menu-button');
const navigation = document.querySelector('.main-nav');

if (menuButton && navigation) {
  menuButton.addEventListener('click', () => {
    const expanded = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!expanded));
    navigation.classList.toggle('open', !expanded);
  });
}

const accountChoices = document.querySelectorAll('input[name="account_type"]');
const companyFields = document.querySelector('[data-company-fields]');

function updateCompanyFields() {
  if (!companyFields) return;
  const selected = document.querySelector('input[name="account_type"]:checked');
  const visible = selected?.value === 'COMPANY';
  companyFields.classList.toggle('visible', visible);
  companyFields.querySelectorAll('input, select').forEach((field) => {
    if (['company_name', 'municipality_id'].includes(field.name)) field.required = visible;
  });
}

accountChoices.forEach((choice) => choice.addEventListener('change', updateCompanyFields));
updateCompanyFields();

document.querySelectorAll('textarea[data-counter]').forEach((textarea) => {
  const output = document.getElementById(textarea.dataset.counter);
  const limit = Number(textarea.maxLength);
  const update = () => {
    output.textContent = `${textarea.value.length.toLocaleString('pt-BR')} de ${limit.toLocaleString('pt-BR')} caracteres. Evite dados pessoais.`;
  };
  textarea.addEventListener('input', update);
  update();
});

const stateSelector = document.querySelector('[data-state-selector]');
const municipalityInput = document.querySelector('[data-municipality-input]');
const municipalitySuggestions = document.getElementById('municipality-suggestions');
const municipalityHelp = document.querySelector('[data-municipality-help]');

async function loadMunicipalities() {
  if (!stateSelector || !municipalityInput || !municipalitySuggestions) return;
  const state = stateSelector.value;
  municipalitySuggestions.replaceChildren();
  municipalityInput.disabled = !state;
  municipalityInput.value = '';

  if (!state) {
    municipalityInput.placeholder = 'Primeiro selecione o estado';
    municipalityHelp.textContent = 'Selecione o estado para carregar todos os municípios brasileiros daquela UF.';
    return;
  }

  municipalityInput.placeholder = 'Carregando municípios...';
  municipalityHelp.textContent = 'Carregando municípios oficiais...';
  try {
    const response = await fetch(`/api/municipios/${encodeURIComponent(state)}`);
    if (!response.ok) throw new Error('Não foi possível carregar municípios');
    const { municipalities, source } = await response.json();
    municipalities.forEach((municipality) => {
      const option = document.createElement('option');
      option.value = municipality.name;
      municipalitySuggestions.append(option);
    });
    municipalityInput.placeholder = 'Digite ou selecione o município';
    municipalityHelp.textContent = source === 'ibge'
      ? 'Lista oficial com todos os municípios da UF selecionada.'
      : 'Serviço oficial indisponível: informe o município corretamente para continuar.';
  } catch (error) {
    municipalityInput.placeholder = 'Informe o município';
    municipalityHelp.textContent = 'Não foi possível carregar a lista agora. Informe o município corretamente.';
  }
}

if (stateSelector && municipalityInput) {
  stateSelector.addEventListener('change', loadMunicipalities);
  if (stateSelector.value) {
    municipalityInput.disabled = false;
    loadMunicipalities().then(() => {
      municipalityInput.value = municipalityInput.defaultValue;
    });
  }
}