import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Switch,
  FormControlLabel,
  TextField,
  Button,
  Divider,
  Alert,
  Card,
  CardContent,
  Grid,
  Tabs,
  Tab,
  LinearProgress,
  MenuItem,
  FormControl,
  InputLabel,
  Select,
} from '@mui/material';
import {
  Save,
  Security,
  Palette,
  Storage,
  History as HistoryIcon,
} from '@mui/icons-material';

const api = window.api;

function Settings({ currentUser }) {
  const [tab, setTab] = useState(0);

  const [llmSettings, setLlmSettings] = useState({
    'llm.provider': '',
    'llm.model': '',
  });
  const [securitySettings, setSecuritySettings] = useState({
    'security.requirePin': false,
    'security.auditRetentionDays': 30,
  });

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [audit, setAudit] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [message, setMessage] = useState(null);

  // LLM API Key state (moved from renderLlmTab to comply with React hooks rules)
  const [apiKey, setApiKey] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);

  const isAdmin = currentUser && currentUser.role === 'admin';

  useEffect(() => {
    loadAll();
  }, []);

  const showMessage = (text, type = 'success') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const loadAll = async () => {
    if (!api || !api.settings) return;
    try {
      setLoading(true);
      setMessage(null);

      const [llmRes, secRes] = await Promise.all([
        api.settings.get('llm.'),
        api.settings.get('security.'),
      ]);

      if (llmRes && !llmRes.error) {
        setLlmSettings((prev) => ({
          ...prev,
          ...llmRes,
        }));
      }
      if (secRes && !secRes.error) {
        setSecuritySettings((prev) => ({
          ...prev,
          ...secRes,
        }));
      }
    } catch (e) {
      showMessage('Błąd ładowania ustawień', 'error');
    } finally {
      setLoading(false);
    }

    loadAudit();
  };

  const loadAudit = async () => {
    if (!api || !api.audit) return;
    try {
      setAuditLoading(true);
      const res = await api.audit.list(50);
      if (res && !res.error && Array.isArray(res)) {
        setAudit(res);
      }
    } catch {
      // audit opcjonalny – nie wyświetlamy błędu jako krytyczny
    } finally {
      setAuditLoading(false);
    }
  };

  const updateLlmField = (key, value) => {
    setLlmSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const updateSecurityField = (key, value) => {
    setSecuritySettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSave = async () => {
    if (!isAdmin || !api || !api.settings) {
      showMessage(
        'Brak uprawnień do modyfikacji ustawień (tylko admin)',
        'error'
      );
      return;
    }
    try {
      setSaving(true);
      setMessage(null);

      const updates = {
        ...llmSettings,
        ...securitySettings,
      };

      const res = await api.settings.update(updates);
      if (res && res.error) {
        showMessage(
          res.error.message || 'Błąd podczas zapisywania ustawień',
          'error'
        );
      } else {
        showMessage('Ustawienia zostały zapisane', 'success');
      }
    } catch (e) {
      showMessage('Błąd podczas zapisywania ustawień', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    // Prosty reset widoku (bez ingerencji w backend)
    setLlmSettings({
      'llm.provider': '',
      'llm.model': '',
    });
    setSecuritySettings({
      'security.requirePin': false,
      'security.auditRetentionDays': 30,
    });
    showMessage(
      'Przywrócono domyślne wartości w UI (nie zapisano jeszcze w backendzie)',
      'success'
    );
  };

  const handleSaveLlmSettings = async () => {
    if (!isAdmin || !api || !api.settings) {
      showMessage('Brak uprawnień (tylko admin)', 'error');
      return;
    }
    try {
      setSaving(true);
      const res = await api.settings.update(llmSettings);
      if (res && res.error) {
        showMessage(res.error.message || 'Błąd zapisu ustawień LLM', 'error');
      } else {
        showMessage('Ustawienia LLM zapisane pomyślnie.', 'success');
      }
    } catch (e) {
      showMessage(e.message || 'Błąd zapisu ustawień LLM', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!isAdmin || !api || !api.settings) {
      showMessage('Brak uprawnień (tylko admin)', 'error');
      return;
    }
    if (!apiKey.trim()) {
      showMessage('Klucz API nie może być pusty', 'warning');
      return;
    }
    try {
      setApiKeySaving(true);
      const res = await api.settings.update({ 'llm.apiKey': apiKey });
      if (res && res.error) {
        showMessage(res.error.message || 'Błąd zapisu klucza API', 'error');
      } else {
        showMessage('Klucz API został zapisany. Aplikacja może wymagać restartu do pełnego załadowania klucza.', 'success');
        setApiKey('');
      }
    } catch (e) {
      showMessage(e.message || 'Błąd zapisu klucza API', 'error');
    } finally {
      setApiKeySaving(false);
    }
  };

  const renderLlmTab = () => (
    <Grid container spacing={3}>
      <Grid item xs={12} md={8}>
        <Card sx={{ backgroundColor: 'background.paper', mb: 3 }}>
          <CardContent>
            <Box display="flex" alignItems="center" mb={2}>
              <Security sx={{ mr: 1, color: 'primary.main' }} />
              <Typography variant="h6">Klucz API OpenAI</Typography>
            </Box>
            <TextField
              label="OpenAI API Key"
              type="password"
              placeholder="sk-..."
              fullWidth
              sx={{ mb: 2 }}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={!isAdmin}
            />
            <Button
              variant="contained"
              color="primary"
              onClick={handleSaveApiKey}
              disabled={!isAdmin || apiKeySaving}
            >
              {apiKeySaving ? 'Zapisywanie...' : 'Zapisz klucz API'}
            </Button>
          </CardContent>
        </Card>

        <Card sx={{ backgroundColor: 'background.paper' }}>
          <CardContent>
            <Box display="flex" alignItems="center" mb={2}>
              <Palette sx={{ mr: 1 }} />
              <Typography variant="h6">Konfiguracja Modelu</Typography>
            </Box>

            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Dostawca LLM</InputLabel>
              <Select
                label="Dostawca LLM"
                value={llmSettings['llm.provider'] || 'openai'}
                onChange={(e) =>
                  updateLlmField('llm.provider', e.target.value)
                }
                disabled={!isAdmin}
              >
                <MenuItem value="openai">OpenAI</MenuItem>
                <MenuItem value="azure">Azure OpenAI</MenuItem>
                <MenuItem value="anthropic">Anthropic (Claude)</MenuItem>
                <MenuItem value="local">Lokalny (Ollama)</MenuItem>
              </Select>
            </FormControl>

            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Model</InputLabel>
              <Select
                label="Model"
                value={llmSettings['llm.model'] || 'gpt-4-turbo'}
                onChange={(e) => updateLlmField('llm.model', e.target.value)}
                disabled={!isAdmin}
              >
                {/* OpenAI models */}
                <MenuItem value="gpt-4-turbo">GPT-4 Turbo</MenuItem>
                <MenuItem value="gpt-4o">GPT-4o</MenuItem>
                <MenuItem value="gpt-4o-mini">GPT-4o Mini</MenuItem>
                <MenuItem value="gpt-4">GPT-4</MenuItem>
                <MenuItem value="gpt-3.5-turbo">GPT-3.5 Turbo</MenuItem>
                {/* Anthropic models */}
                <MenuItem value="claude-3-opus">Claude 3 Opus</MenuItem>
                <MenuItem value="claude-3-sonnet">Claude 3 Sonnet</MenuItem>
                <MenuItem value="claude-3-haiku">Claude 3 Haiku</MenuItem>
                {/* Local models */}
                <MenuItem value="llama3">Llama 3</MenuItem>
                <MenuItem value="mistral">Mistral</MenuItem>
                <MenuItem value="codellama">Code Llama</MenuItem>
              </Select>
            </FormControl>

            <Button
              variant="contained"
              onClick={handleSaveLlmSettings}
              disabled={!isAdmin || saving}
              sx={{ mt: 1 }}
            >
              {saving ? 'Zapisywanie...' : 'Zapisz ustawienia LLM'}
            </Button>

            {!isAdmin && (
              <Alert severity="info" sx={{ mt: 2 }}>
                Tylko administrator może modyfikować konfigurację LLM.
              </Alert>
            )}
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );

  const renderSecurityTab = () => (
    <Grid container spacing={3}>
      <Grid item xs={12} md={8}>
        <Card sx={{ backgroundColor: 'background.paper' }}>
          <CardContent>
            <Box display="flex" alignItems="center" mb={2}>
              <Security sx={{ mr: 1 }} />
              <Typography variant="h6">Bezpieczeństwo</Typography>
            </Box>

            <FormControlLabel
              control={
                <Switch
                  checked={!!securitySettings['security.requirePin']}
                  onChange={(e) =>
                    updateSecurityField(
                      'security.requirePin',
                      e.target.checked
                    )
                  }
                  disabled={!isAdmin}
                />
              }
              label="Wymagaj PIN / dodatkowego potwierdzenia"
              sx={{ mb: 2, display: 'block' }}
            />

            <TextField
              label="Dni retencji logów audytowych"
              type="number"
              fullWidth
              sx={{ mb: 2 }}
              value={
                securitySettings['security.auditRetentionDays'] ?? 30
              }
              onChange={(e) =>
                updateSecurityField(
                  'security.auditRetentionDays',
                  parseInt(e.target.value || '0', 10) || 0
                )
              }
              disabled={!isAdmin}
            />

            {!isAdmin && (
              <Alert severity="info">
                Tylko administrator może zmieniać ustawienia bezpieczeństwa.
              </Alert>
            )}
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );

  const renderAuditTab = () => (
    <Grid container spacing={3}>
      <Grid item xs={12}>
        <Card sx={{ backgroundColor: 'background.paper' }}>
          <CardContent>
            <Box display="flex" alignItems="center" mb={2}>
              <HistoryIcon sx={{ mr: 1 }} />
              <Typography variant="h6">Podgląd audytu</Typography>
            </Box>
            {auditLoading && <LinearProgress sx={{ mb: 2 }} />}
            {audit.length === 0 && !auditLoading && (
              <Typography color="text.secondary">
                Brak danych audytowych lub funkcja nie jest jeszcze
                w pełni zaimplementowana w backendzie.
              </Typography>
            )}
            {audit.slice(0, 20).map((entry) => (
              <Box
                key={entry.id}
                sx={{
                  mb: 1,
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  pb: 0.5,
                }}
              >
                <Typography variant="body2">
                  {entry.actionType || entry.action}{' '}
                  <Typography
                    component="span"
                    variant="caption"
                    color="text.secondary"
                  >
                    ({entry.details?.resourceType || ''}{' '}
                    {entry.details?.resourceId || ''})
                  </Typography>
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                >
                  {entry.timestamp &&
                    new Date(entry.timestamp).toLocaleString()}
                </Typography>
              </Box>
            ))}
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Ustawienia
      </Typography>

      {message && (
        <Alert
          severity={message.type}
          sx={{ mb: 2 }}
        >
          {message.text}
        </Alert>
      )}

      {loading && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Ładowanie ustawień...
        </Alert>
      )}

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ mb: 2 }}
      >
        <Tab label="LLM" />
        <Tab label="Bezpieczeństwo" />
        <Tab label="Audyt" />
      </Tabs>

      {tab === 0 && renderLlmTab()}
      {tab === 1 && renderSecurityTab()}
      {tab === 2 && renderAuditTab()}

      <Paper
        sx={{
          p: 2,
          mt: 3,
          backgroundColor: 'background.paper',
        }}
      >
        <Box
          display="flex"
          gap={2}
          justifyContent="flex-end"
        >
          <Button
            variant="outlined"
            onClick={handleReset}
            disabled={!isAdmin}
          >
            Przywróć domyślne (UI)
          </Button>
          <Button
            variant="contained"
            startIcon={<Save />}
            onClick={handleSave}
            disabled={saving || !isAdmin}
          >
            {saving
              ? 'Zapisywanie...'
              : 'Zapisz ustawienia'}
          </Button>
        </Box>
        {!isAdmin && (
          <Typography
            variant="caption"
            color="text.secondary"
          >
            Zmiana ustawień wymaga roli administratora.
          </Typography>
        )}
      </Paper>
    </Box>
  );
}

export default Settings;