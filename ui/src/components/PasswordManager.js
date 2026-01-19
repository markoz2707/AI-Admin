import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  IconButton,
  Card,
  CardContent,
  Grid,
  Chip,
  Fab,
  LinearProgress,
  Alert,
} from '@mui/material';
import {
  Add,
  Edit,
  Delete,
  Visibility,
  VisibilityOff,
  Lock,
  VpnKey,
} from '@mui/icons-material';

const api = window.api;

function PasswordManager({ currentUser }) {
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedCredential, setSelectedCredential] = useState(null);

  const [formData, setFormData] = useState({
    name: '',
    type: '',
    username: '',
    secret: '',
    meta: '',
  });

  const [generatedPassword, setGeneratedPassword] = useState('');
  const [showSecret, setShowSecret] = useState({});
  const [error, setError] = useState(null);

  const isAdmin = currentUser && currentUser.role === 'admin';

  useEffect(() => {
    loadCredentials();
  }, []);

  const loadCredentials = async () => {
    if (!api || !api.credentials) return;
    try {
      setLoading(true);
      setError(null);
      const res = await api.credentials.list();
      if (res && res.error) {
        setError(res.error.message || 'Błąd ładowania danych');
        setCredentials([]);
      } else {
        setCredentials(Array.isArray(res) ? res : []);
      }
    } catch (e) {
      setError('Błąd ładowania danych');
      setCredentials([]);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = () => {
    if (!isAdmin) return;
    setEditMode(false);
    setSelectedCredential(null);
    setFormData({
      name: '',
      type: '',
      username: '',
      secret: '',
      meta: '',
    });
    setGeneratedPassword('');
    setError(null);
    setDialogOpen(true);
  };

  const handleEdit = (cred) => {
    if (!isAdmin) return;
    setEditMode(true);
    setSelectedCredential(cred);
    setFormData({
      name: cred.name || '',
      type: cred.type || '',
      username: cred.username || '',
      secret: '',
      meta:
        typeof cred.meta === 'string'
          ? cred.meta
          : cred.meta
          ? JSON.stringify(cred.meta)
          : '',
    });
    setGeneratedPassword('');
    setError(null);
    setDialogOpen(true);
  };

  const handleDelete = async (cred) => {
    if (!isAdmin || !api || !api.credentials) return;
    if (
      !window.confirm(
        `Na pewno usunąć credential "${cred.name || cred.id}"?`
      )
    ) {
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const res = await api.credentials.delete(cred.id);
      if (res && res.error) {
        setError(res.error.message || 'Błąd usuwania');
      } else {
        await loadCredentials();
      }
    } catch (e) {
      setError('Błąd usuwania');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!isAdmin || !api || !api.credentials) return;
    try {
      setLoading(true);
      setError(null);

      let metaParsed = formData.meta;
      if (formData.meta) {
        try {
          metaParsed = JSON.parse(formData.meta);
        } catch {
          metaParsed = formData.meta;
        }
      } else {
        metaParsed = undefined;
      }

      const payload = {
        name: formData.name,
        type: formData.type,
        username: formData.username,
        secret: formData.secret || undefined,
        meta: metaParsed,
      };

      let res;
      if (editMode && selectedCredential) {
        res = await api.credentials.update(selectedCredential.id, payload);
      } else {
        res = await api.credentials.create(payload);
      }

      if (res && res.error) {
        setError(res.error.message || 'Błąd zapisu');
      } else {
        setDialogOpen(false);
        await loadCredentials();
      }
    } catch (e) {
      setError('Błąd zapisu');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!isAdmin || !api || !api.credentials) return;
    try {
      setError(null);
      const res = await api.credentials.generatePassword({});
      if (res && res.error) {
        setError(res.error.message || 'Błąd generowania hasła');
      } else if (res && res.password) {
        setGeneratedPassword(res.password);
        setFormData((prev) => ({
          ...prev,
          secret: res.password,
        }));
      }
    } catch (e) {
      setError('Błąd generowania hasła');
    }
  };

  const toggleSecretVisibility = (id) => {
    setShowSecret((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const renderSecret = (cred) => {
    const visible = showSecret[cred.id];
    const val = cred.secretMasked || cred.secret || '';
    if (!val) return '••••••';
    if (!visible) return '•'.repeat(Math.min(String(val).length, 12));
    return String(val);
  };

  return (
    <Box>
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="center"
        mb={2}
      >
        <Typography variant="h5">Manager Haseł</Typography>
        {isAdmin ? (
          <Fab color="primary" size="small" onClick={handleAdd}>
            <Add />
          </Fab>
        ) : (
          <Chip
            label="Tylko podgląd (brak uprawnień do modyfikacji)"
            size="small"
            color="default"
            variant="outlined"
          />
        )}
      </Box>

      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={2}>
        {credentials.map((cred) => (
          <Grid item xs={12} sm={6} md={4} key={cred.id}>
            <Card sx={{ backgroundColor: 'background.paper' }}>
              <CardContent>
                <Box
                  display="flex"
                  justifyContent="space-between"
                  alignItems="flex-start"
                  mb={1}
                >
                  <Typography variant="h6" noWrap>
                    {cred.name || cred.id}
                  </Typography>
                  {isAdmin && (
                    <Box>
                      <IconButton
                        size="small"
                        onClick={() => handleEdit(cred)}
                      >
                        <Edit fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        onClick={() => handleDelete(cred)}
                      >
                        <Delete fontSize="small" />
                      </IconButton>
                    </Box>
                  )}
                </Box>

                <Typography
                  variant="body2"
                  color="text.secondary"
                  gutterBottom
                >
                  Typ: {cred.type || 'n/d'}
                </Typography>
                {cred.username && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    gutterBottom
                  >
                    Użytkownik: {cred.username}
                  </Typography>
                )}

                <Box display="flex" alignItems="center" mb={1}>
                  <Lock sx={{ mr: 1, fontSize: 16 }} />
                  <Typography
                    variant="body2"
                    sx={{ flex: 1, fontFamily: 'monospace' }}
                  >
                    {renderSecret(cred)}
                  </Typography>
                  <IconButton
                    size="small"
                    onClick={() => toggleSecretVisibility(cred.id)}
                  >
                    {showSecret[cred.id] ? (
                      <VisibilityOff fontSize="small" />
                    ) : (
                      <Visibility fontSize="small" />
                    )}
                  </IconButton>
                </Box>

                {cred.meta && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ wordBreak: 'break-word' }}
                  >
                    {typeof cred.meta === 'string'
                      ? cred.meta
                      : JSON.stringify(cred.meta)}
                  </Typography>
                )}

                {cred.createdAt && (
                  <Chip
                    label={`Utworzono: ${new Date(
                      cred.createdAt
                    ).toLocaleDateString()}`}
                    size="small"
                    sx={{ mt: 1 }}
                  />
                )}
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      {credentials.length === 0 && !loading && !error && (
        <Alert severity="info" sx={{ mt: 2 }}>
          Brak zapisanych danych dostępowych.
        </Alert>
      )}

      {/* Dialog dodawania/edycji */}
      <Dialog
        open={dialogOpen}
        onClose={() => !loading && setDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {editMode ? 'Edytuj credential' : 'Dodaj credential'}
        </DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <TextField
            autoFocus
            margin="dense"
            label="Nazwa"
            fullWidth
            variant="outlined"
            value={formData.name}
            onChange={(e) =>
              setFormData((f) => ({ ...f, name: e.target.value }))
            }
            sx={{ mb: 2 }}
          />
          <TextField
            margin="dense"
            label="Typ (np. ssh, db, api)"
            fullWidth
            variant="outlined"
            value={formData.type}
            onChange={(e) =>
              setFormData((f) => ({ ...f, type: e.target.value }))
            }
            sx={{ mb: 2 }}
          />
          <TextField
            margin="dense"
            label="Nazwa użytkownika"
            fullWidth
            variant="outlined"
            value={formData.username}
            onChange={(e) =>
              setFormData((f) => ({ ...f, username: e.target.value }))
            }
            sx={{ mb: 2 }}
          />
          <Box
            display="flex"
            gap={1}
            alignItems="flex-start"
            sx={{ mb: 2 }}
          >
            <TextField
              margin="dense"
              label="Hasło / secret"
              type="password"
              fullWidth
              variant="outlined"
              value={formData.secret}
              onChange={(e) =>
                setFormData((f) => ({ ...f, secret: e.target.value }))
              }
            />
            <Button
              variant="outlined"
              startIcon={<VpnKey />}
              onClick={handleGenerate}
              sx={{ mt: 1, minWidth: 'auto' }}
            >
              Gen
            </Button>
          </Box>

          {generatedPassword && (
            <Alert severity="success" sx={{ mb: 2 }}>
              Tymczasowe wygenerowane hasło:{' '}
              <strong>{generatedPassword}</strong>
            </Alert>
          )}

          <TextField
            margin="dense"
            label="Meta (JSON lub tekst)"
            fullWidth
            multiline
            rows={3}
            variant="outlined"
            value={formData.meta}
            onChange={(e) =>
              setFormData((f) => ({ ...f, meta: e.target.value }))
            }
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => !loading && setDialogOpen(false)}
            disabled={loading}
          >
            Anuluj
          </Button>
          <Button
            onClick={handleSave}
            variant="contained"
            disabled={loading}
          >
            {loading
              ? 'Zapisywanie...'
              : editMode
              ? 'Zapisz'
              : 'Dodaj'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default PasswordManager;