import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  IconButton,
  Chip,
  Grid,
  LinearProgress,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
} from '@mui/material';
import { Send, Clear, PlayArrow, Stop, Refresh, Add, Delete } from '@mui/icons-material';

const api = window.api;

function ServerConsole({ selectedServerId, setSelectedServerId }) {
  const [servers, setServers] = useState([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [serverDetails, setServerDetails] = useState(null);

  const [command, setCommand] = useState('');
  const [consoleOutput, setConsoleOutput] = useState([]);
  const [consoleLoading, setConsoleLoading] = useState(false);

  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesError, setServicesError] = useState(null);

  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState(null);

  const [shares, setShares] = useState([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [sharesError, setSharesError] = useState(null);

  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [userForm, setUserForm] = useState({ username: '', password: '', group: '' });
  const [userAction, setUserAction] = useState(null);

  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareForm, setShareForm] = useState({ name: '', path: '', permissions: '' });
  const [shareAction, setShareAction] = useState(null);
  const [shareTarget, setShareTarget] = useState(null);

  const [error, setError] = useState(null);
  const [connectionLoading, setConnectionLoading] = useState(false);

  const outputRef = useRef(null);

  useEffect(() => {
    if (!api || !api.servers) return;
    const loadServers = async () => {
      try {
        setServerLoading(true);
        const res = await api.servers.list();
        if (res && res.error) {
          setServerError(res.error.message || 'Błąd ładowania serwerów');
          setServers([]);
        } else {
          setServers(Array.isArray(res) ? res : []);
        }
      } catch (e) {
        setServerError('Błąd ładowania serwerów');
        setServers([]);
      } finally {
        setServerLoading(false);
      }
    };
    loadServers();
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [consoleOutput]);

  useEffect(() => {
    if (!selectedServerId) return;
    loadAllForServer(selectedServerId);
  }, [selectedServerId]);

  const loadAllForServer = async (serverId) => {
    await Promise.all([
      loadServerDetails(serverId),
      loadServices(serverId),
      loadUsers(serverId),
      loadShares(serverId),
    ]);
  };

  const loadServerDetails = async (serverId) => {
    if (!api || !api.servers) return;
    try {
      setServerLoading(true);
      setServerError(null);
      const res = await api.servers.get(serverId);
      if (res && res.error) {
        setServerError(res.error.message || 'Błąd pobierania serwera');
        setServerDetails(null);
      } else {
        setServerDetails(res);
      }
    } catch (e) {
      setServerError('Błąd pobierania serwera');
      setServerDetails(null);
    } finally {
      setServerLoading(false);
    }
  };

  const loadServices = async (serverId) => {
    if (!api || !api.services) return;
    try {
      setServicesLoading(true);
      setServicesError(null);
      const res = await api.services.list(serverId);
      if (res && res.error) {
        setServicesError(res.error.message || 'Błąd ładowania usług');
        setServices([]);
      } else {
        setServices(Array.isArray(res) ? res : []);
      }
    } catch (e) {
      setServicesError('Błąd ładowania usług');
      setServices([]);
    } finally {
      setServicesLoading(false);
    }
  };

  const loadUsers = async (serverId) => {
    if (!api || !api.sysusers) return;
    try {
      setUsersLoading(true);
      setUsersError(null);
      const res = await api.sysusers.list(serverId);
      if (res && res.error) {
        setUsersError(res.error.message || 'Błąd ładowania użytkowników');
        setUsers([]);
      } else {
        setUsers(Array.isArray(res) ? res : []);
      }
    } catch (e) {
      setUsersError('Błąd ładowania użytkowników');
      setUsers([]);
    } finally {
      setUsersLoading(false);
    }
  };

  const loadShares = async (serverId) => {
    if (!api || !api.shares) return;
    try {
      setSharesLoading(true);
      setSharesError(null);
      const res = await api.shares.list(serverId);
      if (res && res.error) {
        setSharesError(res.error.message || 'Błąd ładowania udziałów');
        setShares([]);
      } else {
        setShares(Array.isArray(res) ? res : []);
      }
    } catch (e) {
      setSharesError('Błąd ładowania udziałów');
      setShares([]);
    } finally {
      setSharesLoading(false);
    }
  };

  const appendOutput = (text, type = 'output') => {
    const timestamp = new Date().toLocaleTimeString();
    setConsoleOutput((prev) => [...prev, { text, type, timestamp }]);
  };

  const handleConnect = async () => {
    if (!selectedServerId || !api || !api.servers) return;
    setConnectionLoading(true);
    setError(null);
    try {
      const res = await api.servers.connect(selectedServerId);
      if (res && res.error) {
        setError(res.error.message || 'Błąd łączenia z serwerem');
      } else {
        appendOutput('Połączono z serwerem', 'success');
        await loadServerDetails(selectedServerId);
      }
    } catch (e) {
      setError(e.message || 'Błąd łączenia z serwerem');
    } finally {
      setConnectionLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!selectedServerId || !api || !api.servers) return;
    setConnectionLoading(true);
    setError(null);
    try {
      const res = await api.servers.disconnect(selectedServerId);
      if (res && res.error) {
        setError(res.error.message || 'Błąd rozłączania');
      } else {
        appendOutput('Rozłączono z serwerem', 'success');
        await loadServerDetails(selectedServerId);
      }
    } catch (e) {
      setError(e.message || 'Błąd rozłączania');
    } finally {
      setConnectionLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!selectedServerId || !command.trim() || !api || !api.console) return;
    setConsoleLoading(true);
    setError(null);
    appendOutput(`$ ${command}`, 'command');
    try {
      const res = await api.console.execute(selectedServerId, command.trim());
      if (res && res.error) {
        appendOutput(res.error.message || 'Błąd wykonania polecenia', 'error');
      } else {
        if (res.stdout) appendOutput(res.stdout, 'output');
        if (res.stderr) appendOutput(res.stderr, 'error');
      }
    } catch (e) {
      appendOutput(e.message || 'Błąd wykonania polecenia', 'error');
    } finally {
      setConsoleLoading(false);
      setCommand('');
    }
  };

  const handleServiceAction = async (serviceName, action) => {
    if (!selectedServerId || !api || !api.services) return;
    setServicesLoading(true);
    setServicesError(null);
    try {
      const res = await api.services.action(selectedServerId, serviceName, action);
      if (res && res.error) {
        setServicesError(res.error.message || 'Błąd akcji na usłudze');
      }
      await loadServices(selectedServerId);
    } catch (e) {
      setServicesError('Błąd akcji na usłudze');
    } finally {
      setServicesLoading(false);
    }
  };

  const openUserDialog = (action, user) => {
    setUserAction(action);
    setUserForm({
      username: user?.username || '',
      password: '',
      group: '',
    });
    setError(null);
    setUserDialogOpen(true);
  };

  const submitUserAction = async () => {
    if (!selectedServerId || !api || !api.sysusers || !userAction) return;
    setError(null);
    try {
      let res;
      if (userAction === 'add') {
        res = await api.sysusers.add(selectedServerId, {
          username: userForm.username,
          password: userForm.password,
        });
      } else if (userAction === 'remove') {
        res = await api.sysusers.remove(selectedServerId, userForm.username);
      } else if (userAction === 'password') {
        res = await api.sysusers.changePassword(
          selectedServerId,
          userForm.username,
          userForm.password
        );
      } else if (userAction === 'addGroup') {
        res = await api.sysusers.addToGroup(
          selectedServerId,
          userForm.username,
          userForm.group
        );
      } else if (userAction === 'removeGroup') {
        res = await api.sysusers.removeFromGroup(
          selectedServerId,
          userForm.username,
          userForm.group
        );
      }

      if (res && res.error) {
        setError(res.error.message || 'Błąd operacji na użytkowniku');
      } else {
        setUserDialogOpen(false);
        await loadUsers(selectedServerId);
      }
    } catch (e) {
      setError('Błąd operacji na użytkowniku');
    }
  };

  const openShareDialog = (action, share) => {
    setShareAction(action);
    setShareTarget(share || null);
    setShareForm({
      name: share?.name || '',
      path: share?.path || '',
      permissions: '',
    });
    setError(null);
    setShareDialogOpen(true);
  };

  const submitShareAction = async () => {
    if (!selectedServerId || !api || !api.shares || !shareAction) return;
    setError(null);
    try {
      let res;
      if (shareAction === 'create') {
        res = await api.shares.create(selectedServerId, {
          name: shareForm.name,
          path: shareForm.path,
          permissions: shareForm.permissions,
        });
      } else if (shareAction === 'delete' && shareTarget) {
        res = await api.shares.delete(selectedServerId, shareTarget.name);
      } else if (shareAction === 'perm' && shareTarget) {
        res = await api.shares.modifyPermissions(
          selectedServerId,
          shareTarget.name,
          shareForm.permissions
        );
      }
      if (res && res.error) {
        setError(res.error.message || 'Błąd operacji na udziale');
      } else {
        setShareDialogOpen(false);
        await loadShares(selectedServerId);
      }
    } catch (e) {
      setError('Błąd operacji na udziale');
    }
  };

  const getOutputColor = (type) => {
    switch (type) {
      case 'command':
        return 'primary.main';
      case 'error':
        return 'error.main';
      case 'success':
        return 'success.main';
      default:
        return 'text.primary';
    }
  };

  if (!selectedServerId) {
    return (
      <Box>
        <Typography variant="h5" gutterBottom>
          Konsola serwera
        </Typography>
        <Paper sx={{ p: 2, backgroundColor: 'background.paper' }}>
          <Typography color="text.secondary">
            Wybierz serwer z listy, aby korzystać z konsoli i operacji zarządzania.
          </Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Konsola serwera
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Szczegóły serwera + wybór */}
      <Paper sx={{ p: 2, mb: 2, backgroundColor: 'background.paper' }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} md={4}>
            <FormControl fullWidth>
              <InputLabel>Serwer</InputLabel>
              <Select
                label="Serwer"
                value={selectedServerId}
                onChange={(e) => {
                  setSelectedServerId(e.target.value);
                  setConsoleOutput([]);
                  loadAllForServer(e.target.value);
                }}
              >
                {servers.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name} ({s.host || s.ip})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} md={5}>
            {serverLoading && <LinearProgress />}
            {serverDetails && (
              <Box display="flex" flexWrap="wrap" gap={1} alignItems="center">
                <Chip
                  label={serverDetails.environment || serverDetails.env || 'env: ?'}
                  size="small"
                />
                <Chip
                  label={serverDetails.status || serverDetails.lastCheckStatus || 'offline'}
                  size="small"
                  color={
                    (serverDetails.status || serverDetails.lastCheckStatus) === 'online'
                      ? 'success'
                      : (serverDetails.status || serverDetails.lastCheckStatus) === 'offline'
                      ? 'default'
                      : 'warning'
                  }
                />
                {Array.isArray(serverDetails.tags) &&
                  serverDetails.tags.map((t) => (
                    <Chip key={t} label={t} size="small" variant="outlined" />
                  ))}
              </Box>
            )}
          </Grid>
          <Grid item xs={12} md={3}>
            <Box display="flex" gap={1}>
              <Button
                variant="contained"
                color="success"
                startIcon={<PlayArrow />}
                onClick={handleConnect}
                disabled={connectionLoading || !selectedServerId}
                size="small"
              >
                Połącz
              </Button>
              <Button
                variant="outlined"
                color="warning"
                startIcon={<Stop />}
                onClick={handleDisconnect}
                disabled={connectionLoading || !selectedServerId}
                size="small"
              >
                Rozłącz
              </Button>
            </Box>
          </Grid>
        </Grid>
      </Paper>

      {/* Konsola poleceń */}
      <Paper sx={{ p: 2, mb: 2, backgroundColor: 'background.paper' }}>
        <Box display="flex" gap={1} alignItems="center" mb={1}>
          <TextField
            fullWidth
            placeholder="Wpisz polecenie do wykonania na serwerze..."
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleExecute();
              }
            }}
            disabled={consoleLoading}
          />
          <Button
            variant="contained"
            endIcon={<Send />}
            onClick={handleExecute}
            disabled={!command.trim() || consoleLoading}
          >
            Wykonaj
          </Button>
          <IconButton
            onClick={() => setConsoleOutput([])}
            disabled={consoleLoading}
          >
            <Clear />
          </IconButton>
        </Box>
        <Box
          ref={outputRef}
          sx={{
            mt: 1,
            height: 220,
            overflow: 'auto',
            backgroundColor: '#000',
            color: '#0f0',
            fontFamily: 'monospace',
            p: 1,
            borderRadius: 1,
            fontSize: '0.8rem',
          }}
        >
          {consoleOutput.length === 0 ? (
            <Typography
              color="text.secondary"
              sx={{ fontStyle: 'italic' }}
            >
              Brak outputu. Wpisz polecenie i użyj "Wykonaj".
            </Typography>
          ) : (
            consoleOutput.map((line, idx) => (
              <Box key={idx} sx={{ color: getOutputColor(line.type) }}>
                <span style={{ color: '#888', marginRight: 8 }}>
                  [{line.timestamp}]
                </span>
                {line.text}
              </Box>
            ))
          )}
        </Box>
      </Paper>

      <Grid container spacing={2}>
        {/* Usługi */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2, backgroundColor: 'background.paper', mb: 2 }}>
            <Box
              display="flex"
              justifyContent="space-between"
              alignItems="center"
              mb={1}
            >
              <Typography variant="h6">Usługi</Typography>
              <IconButton
                size="small"
                onClick={() => loadServices(selectedServerId)}
              >
                <Refresh fontSize="small" />
              </IconButton>
            </Box>
            {servicesLoading && <LinearProgress sx={{ mb: 1 }} />}
            {servicesError && (
              <Typography color="error">{servicesError}</Typography>
            )}
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Nazwa</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Akcje</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {services.map((svc) => (
                  <TableRow key={svc.name}>
                    <TableCell>{svc.name}</TableCell>
                    <TableCell>{svc.status}</TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() =>
                          handleServiceAction(svc.name, 'start')
                        }
                      >
                        start
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          handleServiceAction(svc.name, 'stop')
                        }
                      >
                        stop
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          handleServiceAction(svc.name, 'restart')
                        }
                      >
                        restart
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {services.length === 0 && !servicesLoading && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      align="center"
                      sx={{ color: 'text.secondary' }}
                    >
                      Brak danych o usługach.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>
        </Grid>

        {/* Użytkownicy */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2, backgroundColor: 'background.paper', mb: 2 }}>
            <Box
              display="flex"
              justifyContent="space-between"
              alignItems="center"
              mb={1}
            >
              <Typography variant="h6">Użytkownicy systemowi</Typography>
              <Box>
                <IconButton
                  size="small"
                  onClick={() => loadUsers(selectedServerId)}
                >
                  <Refresh fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  onClick={() => openUserDialog('add')}
                >
                  <Add fontSize="small" />
                </IconButton>
              </Box>
            </Box>
            {usersLoading && <LinearProgress sx={{ mb: 1 }} />}
            {usersError && (
              <Typography color="error">{usersError}</Typography>
            )}
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Użytkownik</TableCell>
                  <TableCell>Grupy</TableCell>
                  <TableCell align="right">Akcje</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.username}>
                    <TableCell>{u.username}</TableCell>
                    <TableCell>
                      {Array.isArray(u.groups)
                        ? u.groups.join(', ')
                        : u.groups || ''}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() =>
                          openUserDialog('password', {
                            username: u.username,
                          })
                        }
                      >
                        hasło
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          openUserDialog('addGroup', {
                            username: u.username,
                          })
                        }
                      >
                        +grp
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          openUserDialog('removeGroup', {
                            username: u.username,
                          })
                        }
                      >
                        -grp
                      </Button>
                      <IconButton
                        size="small"
                        onClick={() =>
                          openUserDialog('remove', {
                            username: u.username,
                          })
                        }
                      >
                        <Delete fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
                {users.length === 0 && !usersLoading && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      align="center"
                      sx={{ color: 'text.secondary' }}
                    >
                      Brak użytkowników do wyświetlenia.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>
        </Grid>

        {/* Udziały */}
        <Grid item xs={12}>
          <Paper sx={{ p: 2, backgroundColor: 'background.paper' }}>
            <Box
              display="flex"
              justifyContent="space-between"
              alignItems="center"
              mb={1}
            >
              <Typography variant="h6">Udziały</Typography>
              <Box>
                <IconButton
                  size="small"
                  onClick={() => loadShares(selectedServerId)}
                >
                  <Refresh fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  onClick={() => openShareDialog('create')}
                >
                  <Add fontSize="small" />
                </IconButton>
              </Box>
            </Box>
            {sharesLoading && <LinearProgress sx={{ mb: 1 }} />}
            {sharesError && (
              <Typography color="error">{sharesError}</Typography>
            )}
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Nazwa</TableCell>
                  <TableCell>Ścieżka</TableCell>
                  <TableCell>Uprawnienia</TableCell>
                  <TableCell align="right">Akcje</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {shares.map((sh) => (
                  <TableRow key={sh.name}>
                    <TableCell>{sh.name}</TableCell>
                    <TableCell>{sh.path}</TableCell>
                    <TableCell>
                      {Array.isArray(sh.permissions)
                        ? sh.permissions.join(', ')
                        : sh.permissions || ''}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() => openShareDialog('perm', sh)}
                      >
                        prawa
                      </Button>
                      <IconButton
                        size="small"
                        onClick={() => openShareDialog('delete', sh)}
                      >
                        <Delete fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
                {shares.length === 0 && !sharesLoading && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      align="center"
                      sx={{ color: 'text.secondary' }}
                    >
                      Brak udziałów do wyświetlenia.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
      </Grid>

      {/* Dialog operacji na użytkownikach */}
      <Dialog
        open={userDialogOpen}
        onClose={() => setUserDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Operacja na użytkowniku</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            margin="dense"
            label="Nazwa użytkownika"
            value={userForm.username}
            onChange={(e) =>
              setUserForm((f) => ({ ...f, username: e.target.value }))
            }
          />
          {(userAction === 'add' || userAction === 'password') && (
            <TextField
              fullWidth
              margin="dense"
              label="Hasło"
              type="password"
              value={userForm.password}
              onChange={(e) =>
                setUserForm((f) => ({ ...f, password: e.target.value }))
              }
            />
          )}
          {(userAction === 'addGroup' || userAction === 'removeGroup') && (
            <TextField
              fullWidth
              margin="dense"
              label="Grupa"
              value={userForm.group}
              onChange={(e) =>
                setUserForm((f) => ({ ...f, group: e.target.value }))
              }
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUserDialogOpen(false)}>Anuluj</Button>
          <Button onClick={submitUserAction} variant="contained">
            Wykonaj
          </Button>
        </DialogActions>
      </Dialog>

      {/* Dialog operacji na udziałach */}
      <Dialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Operacja na udziale</DialogTitle>
        <DialogContent>
          {(shareAction === 'create' || shareAction === 'perm') && (
            <>
              <TextField
                fullWidth
                margin="dense"
                label="Nazwa udziału"
                value={shareForm.name}
                disabled={shareAction === 'perm'}
                onChange={(e) =>
                  setShareForm((f) => ({ ...f, name: e.target.value }))
                }
              />
              {shareAction === 'create' && (
                <TextField
                  fullWidth
                  margin="dense"
                  label="Ścieżka"
                  value={shareForm.path}
                  onChange={(e) =>
                    setShareForm((f) => ({ ...f, path: e.target.value }))
                  }
                />
              )}
              <TextField
                fullWidth
                margin="dense"
                label="Uprawnienia (np. user:rw,group:r)"
                value={shareForm.permissions}
                onChange={(e) =>
                  setShareForm((f) => ({
                    ...f,
                    permissions: e.target.value,
                  }))
                }
              />
            </>
          )}
          {shareAction === 'delete' && shareTarget && (
            <Typography>
              Czy na pewno usunąć udział "{shareTarget.name}"?
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShareDialogOpen(false)}>Anuluj</Button>
          <Button onClick={submitShareAction} variant="contained">
            Wykonaj
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default ServerConsole;