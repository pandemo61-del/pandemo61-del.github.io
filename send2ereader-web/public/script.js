const createKeyBtn = document.getElementById('createKeyBtn');
const receiverKeyInput = document.getElementById('receiverKey');
const senderKeyInput = document.getElementById('senderKey');
const uploadForm = document.getElementById('uploadForm');
const statusBox = document.getElementById('status');
const downloadBox = document.getElementById('downloadBox');
const downloadLink = document.getElementById('downloadLink');
const optionInputs = uploadForm.querySelectorAll('.checkboxes input[type="checkbox"]');
const comicModeInputs = uploadForm.querySelectorAll('input[name="comicMode"]');
const readerProfileSelect = document.getElementById('readerProfile');
const customResolutionBox = document.getElementById('customResolution');
const customWidthInput = document.getElementById('customWidth');
const customHeightInput = document.getElementById('customHeight');
const optionCookieName = 'send2ereader_options';

let activeKey = null;
let pollTimer = null;

function loadOptionPreferences() {
  const cookiePrefix = `${optionCookieName}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(cookiePrefix));

  if (!cookie) return;

  try {
    const preferences = JSON.parse(decodeURIComponent(cookie.slice(cookiePrefix.length)));
    optionInputs.forEach((input) => {
      if (typeof preferences[input.name] === 'boolean') {
        input.checked = preferences[input.name];
      }
    });
    comicModeInputs.forEach((input) => {
      input.checked = input.value === preferences.comicMode;
    });
    if ([...readerProfileSelect.options].some((option) => option.value === preferences.readerProfile)) {
      readerProfileSelect.value = preferences.readerProfile;
    }
    if (Number.isInteger(preferences.customWidth)) customWidthInput.value = preferences.customWidth;
    if (Number.isInteger(preferences.customHeight)) customHeightInput.value = preferences.customHeight;
  } catch (error) {
    // Ignore an invalid or outdated preferences cookie.
  }

  updateCustomResolutionVisibility();
}

function saveOptionPreferences() {
  const preferences = {
    readerProfile: readerProfileSelect.value,
    customWidth: Number(customWidthInput.value),
    customHeight: Number(customHeightInput.value),
    comicMode: [...comicModeInputs].find((input) => input.checked)?.value || 'bd'
  };
  optionInputs.forEach((input) => {
    preferences[input.name] = input.checked;
  });

  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${optionCookieName}=${encodeURIComponent(JSON.stringify(preferences))}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
}

function updateCustomResolutionVisibility() {
  customResolutionBox.classList.toggle('hidden', readerProfileSelect.value !== 'custom');
}

loadOptionPreferences();
optionInputs.forEach((input) => input.addEventListener('change', saveOptionPreferences));
comicModeInputs.forEach((input) => input.addEventListener('change', saveOptionPreferences));
readerProfileSelect.addEventListener('change', () => {
  updateCustomResolutionVisibility();
  saveOptionPreferences();
});
customWidthInput.addEventListener('change', saveOptionPreferences);
customHeightInput.addEventListener('change', saveOptionPreferences);

function setStatus(message, type = '') {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`.trim();
}

function pollStatus() {
  if (!activeKey) {
    receiverKeyInput.value = '----';
    downloadBox.classList.add('hidden');
    return;
  }

  fetch(`/api/status/${activeKey}`)
    .then((res) => res.json())
    .then((data) => {
      if (data.error) {
        clearInterval(pollTimer);
        activeKey = null;
        receiverKeyInput.value = '----';
        downloadBox.classList.add('hidden');
        return;
      }

      if (data.file) {
        downloadLink.href = `/download/${encodeURIComponent(data.file.name)}?key=${activeKey}`;
        downloadLink.textContent = data.file.name;
        downloadBox.classList.remove('hidden');
      } else {
        downloadBox.classList.add('hidden');
      }
    })
    .catch(() => {
      clearInterval(pollTimer);
      activeKey = null;
      receiverKeyInput.value = '----';
      downloadBox.classList.add('hidden');
    });
}

function generateKey() {
  fetch('/api/generate', { method: 'POST' })
    .then(async (res) => ({ ok: res.ok, key: await res.text() }))
    .then(({ ok, key }) => {
      if (!ok) {
        setStatus('Open this page on your e-reader to generate a key.', 'error');
        return;
      }

      if (key === 'error') {
        receiverKeyInput.value = '----';
        return;
      }

      activeKey = key;
      receiverKeyInput.value = key;
      senderKeyInput.value = key;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(pollStatus, 5000);
      pollStatus();
      })
      .catch(() => setStatus('Could not generate a key. Please try again.', 'error'));
    }

    createKeyBtn.addEventListener('click', generateKey);

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(uploadForm);

  setStatus('Uploading...', '');

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (!response.ok || result.success === false) {
      setStatus(result.message || 'Upload failed', 'error');
      return;
    }

    setStatus(result.message, 'success');
    if (result.key) {
      senderKeyInput.value = result.key;
    }
  } catch (error) {
    setStatus('Upload error. Please try again.', 'error');
  }
});

window.addEventListener('load', async () => {
  try {
    const response = await fetch('/api/device');
    const device = await response.json();

    if (device.isEreader) {
      document.querySelector('.send-panel').classList.add('hidden');
      document.querySelector('.workflow-grid').classList.add('reader-mode');
      generateKey();
      return;
    }
  } catch (error) {
    // If device detection fails, do not generate a key on an unknown device.
  }

  createKeyBtn.closest('.panel').classList.add('hidden');
  document.querySelector('.workflow-grid').classList.add('sender-mode');
  const senderKeyLabel = uploadForm.querySelector('label[for="senderKey"]');
  senderKeyLabel.textContent = 'Code shown on your e-reader';
  senderKeyInput.placeholder = 'Enter the 4-character code';
  senderKeyInput.focus();
});
