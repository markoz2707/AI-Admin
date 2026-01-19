import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  IconButton,
  Chip,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Fab,
  LinearProgress,
  FormControl,
  InputLabel,
  Select,
  Alert,
} from '@mui/material';
import { PlayArrow, Edit, Delete, Add, Refresh, Terminal } from '@mui/icons-material';

function ServerList({
  goto,
  selectedServerId,
  setSelectedServerId,
  servers,
  serversLoading,
  serversError,
  reloadServers,
}) {
  const api = window.api;

  const [filters, setFilters] = useState({
    environment: '',
    tag: '',
  });

  const [credentials, setCredentials] = useState([]);
  const [credentialsLoading, setCredentialsLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedServer, setSelectedServer] = useState(null);
  const [operationError, setOperationError] = useState(null);
  const [operationLoading, setOperationLoading] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    ip: '',
    port: 22,
    type: 'linux',
    accessType: 'ssh',
    environment: '',
    tags: '',
    credentialId: '',
  });

  useEffect(() => {
    const loadCredentials = async () => {
      if (!api || !api.credentials) return;
      try {
        setCredentialsLoading(true);
        const res = await api.credentials.list();
        if (res && res.error) {
          console.error('credentials:list error', res.error);
          setCredentials([]);
        } else {
          setCredentials(Array.isArray(res) ? res : []);
        }
      } catch (err) {
        console.error('credentials:list exception', err);
        setCredentials([]);
      } finally {
        setCredentialsLoading(false);
      }
    };
    loadCredentials();
  }, [api]);

  const applyFilters = (list) => {
    return list.filter((s) => {
      if (filters.environment && (s.environment || s.env) !== filters.environment) {
        return false;
      }
      if (filters.tag) {
        const tags = Array.isArray(s.tags)
          ? s.tags
          : typeof s.tags === 'string'
          ? s.tags.split(',').map((t) => t.trim())
          : [];
        if (!tags.includes(filters.tag)) {
          return false;
        }
      }
      return true;
    });
  };

  const handleOpenDialogForCreate = () => {
    setEditMode(false);
    setSelectedServer(null);
    setFormData({
      name: '',
      ip: '',
      port: 22,
      type: 'linux',
      accessType: 'ssh',
      environment: '',
      tags: '',
      credentialId: '',
    });
    setOperationError(null);
    setDialogOpen(true);
  };

  const handleOpenDialogForEdit = (server) => {
    setEditMode(true);
    setSelectedServer(server);
    setFormData({
      name: server.name || '',
      ip: server.host || server.ip || '',
      port: server.port || 22,
      type: server.os || server.type || 'linux',
      accessType: server.accessType || 'ssh',
      environment: server.environment || server.env || '',
      tags: Array.isArray(server.tags) ? server.tags.join(',') : server.tags || '',
      credentialId: server.credentialId || server.credential_id || '',
    });
    setOperationError(null);
    setDialogOpen(true);
  };

  const handleSaveServer = async () => {
    if (!api || !api.servers) return;
    setOperationLoading(true);
    setOperationError(null);

    const payload = {
      name: formData.name,
      host: formData.ip,
      port: parseInt(formData.port, 10) || 22,
      os: formData.type,
      accessType: formData.accessType,
      environment: formData.environment || undefined,
      tags: formData.tags
        ? formData.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
      credentialId: formData.credentialId || null,
    };

    try {
      let res;
      if (editMode && selectedServer) {
        res = await api.servers.update(selectedServer.id, payload);
      } else {
        res = await api.servers.create(payload);
      }
      if (res && res.error) {
        setOperationError(res.error.message || 'Błąd zapisu serwera');
      } else {
        setDialogOpen(false);
        await reloadServers();
      }
    } catch (err) {
      console.error('save server error', err);
      setOperationError('Błąd zapisu serwera');
    } finally {
      setOperationLoading(false);
    }
  };

  const handleDeleteServer = async (server) => {
    if (!api || !api.servers) return;
    if (!window.confirm(`Usunąć serwer "${server.name}"?`)) return;
    setOperationLoading(true);
    setOperationError(null);
    try {
      const res = await api.servers.delete(server.id);
      if (res && res.error) {
        setOperationError(res.error.message || 'Błąd usuwania serwera');
      } else {
        if (selectedServerId === server.id) {
          setSelectedServerId(null);
        }
        await reloadServers();
      }
    } catch (err) {
      console.error('delete server error', err);
      setOperationError('Błąd usuwania serwera');
    } finally {
      setOperationLoading(false);
    }
  };

  const handleConnect = async (server) => {
    if (!api || !api.servers) return;
    setOperationLoading(true);
    setOperationError(null);
    try {
      const res = await api.servers.connect(server.id);
      if (res && res.error) {
        setOperationError(res.error.message || 'Błąd łączenia z serwerem');
      } else {
        await reloadServers();
      }
    } catch (err) {
      console.error('connect server error', err);
      setOperationError('Błąd łączenia z serwerem');
    } finally {
      setOperationLoading(false);
    }
  };

  const handleGotoConsole = (server) => {
    setSelectedServerId(server.id);
    goto('console');
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'online':
        return 'success';
      case 'offline':
        return 'default';
      case 'connecting':
        return 'warning';
      default:
        return 'default';
    }
  };

  const filteredServers = applyFilters(servers || []);

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h5">Lista serwerów</Typography>
        <Box>
          <Button
            startIcon={<Refresh />}
            onClick={reloadServers}
            disabled={serversLoading || operationLoading}
            sx={{ mr: 1 }}
          >
            Odśwież
          </Button>
          <Fab
            color="primary"
            size="small"
            onClick={handleOpenDialogForCreate}
            disabled={operationLoading}
          >
            <Add />
          </Fab>
        </Box>
      </Box>

      <Box display="flex" gap={2} mb={2}>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Środowisko</InputLabel>
          <Select
            label="Środowisko"
            value={filters.environment}
            onChange={(e) =>
              setFilters((f) => ({ ...f, environment: e.target.value }))
            }
          >
            <MenuItem value="">
              <em>Wszystkie</em>
            </MenuItem>
            <MenuItem value="prod">prod</MenuItem>
            <MenuItem value="stage">stage</MenuItem>
            <MenuItem value="dev">dev</MenuItem>
          </Select>
        </FormControl>

        <TextField
          size="small"
          label="Tag"
          value={filters.tag}
          onChange={(e) =>
            setFilters((f) => ({ ...f, tag: e.target.value.trim() }))
          }
        />
      </Box>

      {serversLoading && <LinearProgress sx={{ mb: 2 }} />}

      {serversError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {serversError}
        </Alert>
      )}

      {operationError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {operationError}
        </Alert>
      )}

      <List>
        {filteredServers.map((server) => (
          <ListItem
            key={server.id}
            sx={{
              border: 1,
              borderColor:
                selectedServerId === server.id ? 'primary.main' : 'divider',
              borderRadius: 1,
              mb: 1,
              backgroundColor: 'background.paper',
            }}
          >
            <ListItemText
              primary={
                <Box display="flex" alignItems="center" gap={1}>
                  <Typography variant="subtitle1">{server.name}</Typography>
                  <Chip
                    label={server.status || 'unknown'}
                    color={getStatusColor(server.status)}
                    size="small"
                  />
                  {(server.environment || server.env) && (
                    <Chip
                      label={server.environment || server.env}
                      size="small"
                      variant="outlined"
                    />
                  )}
                  {Array.isArray(server.tags) &&
                    server.tags.map((t) => (
                      <Chip
                        key={t}
                        label={t}
                        size="small"
                        variant="outlined"
                      />
                    ))}
                </Box>
              }
              secondary={
                <>
                  <Typography component="span">
                    {server.host || server.ip}:{server.port || 22} ({server.os || 'linux'} / {server.accessType || 'ssh'})
                  </Typography>
                  {server.credentialId && (
                    <Typography
                      component="span"
                      sx={{ ml: 1 }}
                      color="text.secondary"
                    >
                      • credential #{server.credentialId}
                    </Typography>
                  )}
                </>
              }
            />
            <ListItemSecondaryAction>
              <IconButton
                edge="end"
                onClick={() => handleConnect(server)}
                disabled={operationLoading}
                title="Połącz"
              >
                <PlayArrow />
              </IconButton>
              <IconButton
                edge="end"
                onClick={() => handleGotoConsole(server)}
                disabled={operationLoading}
                title="Konsola"
              >
                <Terminal />
              </IconButton>
              <IconButton
                edge="end"
                onClick={() => handleOpenDialogForEdit(server)}
                disabled={operationLoading}
                title="Edytuj"
              >
                <Edit />
              </IconButton>
              <IconButton
                edge="end"
                onClick={() => handleDeleteServer(server)}
                disabled={operationLoading}
                title="Usuń"
              >
                <Delete />
              </IconButton>
            </ListItemSecondaryAction>
          </ListItem>
        ))}
      </List>

      {filteredServers.length === 0 && !serversLoading && !serversError && (
        <Typography color="text.secondary" align="center" sx={{ mt: 4 }}>
          Brak serwerów spełniających kryteria. Dodaj lub zmień filtry.
        </Typography>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => {
          if (!operationLoading) setDialogOpen(false);
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {editMode ? 'Edytuj serwer' : 'Dodaj nowy serwer'}
        </DialogTitle>
        <DialogContent>
          {operationError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {operationError}
            </Alert>
          )}
          <TextField
            autoFocus
            margin="dense"
            label="Nazwa serwera"
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
            label="Adres IP / host"
            fullWidth
            variant="outlined"
            value={formData.ip}
            onChange={(e) =>
              setFormData((f) => ({ ...f, ip: e.target.value }))
            }
            sx={{ mb: 2 }}
          />
          <TextField
            margin="dense"
            label="Port"
            type="number"
            fullWidth
            variant="outlined"
            value={formData.port}
            onChange={(e) =>
              setFormData((f) => ({ ...f, port: e.target.value }))
            }
            sx={{ mb: 2 }}
          />
          <TextField
            select
            margin="dense"
            label="Typ systemu"
            fullWidth
            variant="outlined"
            value={formData.type}
            onChange={(e) =>
              setFormData((f) => ({ ...f, type: e.target.value }))
            }
            sx={{ mb: 2 }}
          >
            <MenuItem value="linux">Linux</MenuItem>
            <MenuItem value="windows">Windows</MenuItem>
          </TextField>
          <TextField
            select
            margin="dense"
            label="Typ połączenia"
            fullWidth
            variant="outlined"
            value={formData.accessType}
            onChange={(e) => {
              const accessType = e.target.value;
              let port = formData.port;
              // Auto-set default port based on access type
              if (accessType === 'ssh' && formData.port === 3389) port = 22;
              if (accessType === 'rdp' && formData.port === 22) port = 3389;
              if (accessType === 'winrm' && (formData.port === 22 || formData.port === 3389)) port = 5985;
              setFormData((f) => ({ ...f, accessType, port }));
            }}
            sx={{ mb: 2 }}
          >
            <MenuItem value="ssh">SSH</MenuItem>
            <MenuItem value="rdp">RDP</MenuItem>
            <MenuItem value="winrm">WinRM</MenuItem>
          </TextField>
          <TextField
            margin="dense"
            label="Środowisko (np. prod/dev)"
            fullWidth
            variant="outlined"
            value={formData.environment}
            onChange={(e) =>
              setFormData((f) => ({ ...f, environment: e.target.value }))
            }
            sx={{ mb: 2 }}
          />
          <TextField
            margin="dense"
            label="Tagi (comma-separated)"
            fullWidth
            variant="outlined"
            value={formData.tags}
            onChange={(e) =>
              setFormData((f) => ({ ...f, tags: e.target.value }))
            }
            sx={{ mb: 2 }}
          />
          <FormControl fullWidth margin="dense">
            <InputLabel>Credential</InputLabel>
            <Select
              label="Credential"
              value={formData.credentialId}
              onChange={(e) =>
                setFormData((f) => ({
                  ...f,
                  credentialId: e.target.value,
                }))
              }
            >
              <MenuItem value="">
                <em>Brak</em>
              </MenuItem>
              {credentials.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name || c.id} ({c.type || c.kind || 'cred'})
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {credentialsLoading && (
            <LinearProgress sx={{ mt: 1 }} />
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => !operationLoading && setDialogOpen(false)}
            disabled={operationLoading}
          >
            Anuluj
          </Button>
          <Button
            onClick={handleSaveServer}
            variant="contained"
            disabled={operationLoading}
          >
            {operationLoading
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

export default ServerList;