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