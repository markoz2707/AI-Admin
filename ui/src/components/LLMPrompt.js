import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  LinearProgress,
  Grid,
  Alert,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import {
  SmartToy,
  Send,
  History,
  CheckCircle,
  Error as ErrorIcon,
  ExpandMore,
  TaskAlt,
} from '@mui/icons-material';

const api = window.api;

function LLMPrompt({ servers, selectedServerId, setSelectedServerId, currentUser }) {
  const [prompt, setPrompt] = useState('');
  const [targetServerId, setTargetServerId] = useState(selectedServerId || '');
  const [includeContext, setIncludeContext] = useState(true);
  const [autoExecute, setAutoExecute] = useState(true);

  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadingAsk, setLoadingAsk] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (selectedServerId) {
      setTargetServerId(selectedServerId);
    }
  }, [selectedServerId]);

  const canAutoExecute =
    currentUser && currentUser.role && currentUser.role !== 'readonly';

  const loadHistory = async () => {
    if (!api || !api.llm || typeof api.llm.history !== 'function') return;
    try {
      setLoadingHistory(true);
      const res = await api.llm.history(20);
      if (res && res.error) {
        setError(res.error.message || 'Błąd pobierania historii LLM');
        setHistory([]);
      } else {
        setHistory(Array.isArray(res) ? res : []);
      }
    } catch (e) {
      setError('Błąd pobierania historii LLM');
      setHistory([]);
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const handleAsk = async () => {
    if (!prompt.trim() || !api || !api.llm) return;
    setLoadingAsk(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.llm.ask({
        prompt: prompt.trim(),
        serverId: targetServerId || null,
        includeContext,
        autoExecute: autoExecute && canAutoExecute,
        user: currentUser?.username,
      });
      if (res && res.error) {
        setError(res.error.message || 'Błąd zapytania LLM');
      } else {
        setResult(res);
      }
    } catch (e) {
      setError('Błąd zapytania LLM');
    } finally {
      setLoadingAsk(false);
      loadHistory();
    }
  };

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        LLM – Asystent operacyjny
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid item xs={12} md={7}>
          <Paper sx={{ p: 2, backgroundColor: 'background.paper' }}>
            <Typography variant="h6" gutterBottom>
              Nowe zapytanie
            </Typography>

            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Serwer docelowy (opcjonalny)</InputLabel>
              <Select
                label="Serwer docelowy (opcjonalny)"
                value={targetServerId || ''}
                onChange={(e) => {
                  setTargetServerId(e.target.value || '');
                  if (e.target.value) {
                    setSelectedServerId(e.target.value);
                  }
                }}
              >
                <MenuItem value="">
                  <em>Brak – kontekst globalny</em>
                </MenuItem>
                {servers.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name} ({s.host})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Box display="flex" gap={2} mb={2} flexWrap="wrap">
              <Chip
                label={
                  includeContext
                    ? 'Kontekst: włączony'
                    : 'Kontekst: wyłączony'
                }
                color={includeContext ? 'primary' : 'default'}
                variant={includeContext ? 'filled' : 'outlined'}
                onClick={() => setIncludeContext((v) => !v)}
              />
              <Chip
                label={
                  autoExecute && canAutoExecute
                    ? 'Auto-execute: włączone'
                    : 'Auto-execute: wyłączone'
                }
                color={
                  autoExecute && canAutoExecute ? 'secondary' : 'default'
                }
                variant={
                  autoExecute && canAutoExecute
                    ? 'filled'
                    : 'outlined'
                }
                onClick={() => {
                  if (!canAutoExecute) return;
                  setAutoExecute((v) => !v);
                }}
              />
              {!canAutoExecute && (
                <Chip
                  label="Brak uprawnień do auto-execute"
                  size="small"
                  color="warning"
                  variant="outlined"
                />
              )}
            </Box>

            <TextField
              fullWidth
              multiline
              rows={5}
              placeholder="Opisz co chcesz osiągnąć (np. skonfiguruj nginx na serwerze X, zrób backup bazy, sprawdź status usług)..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              sx={{ mb: 2 }}
            />

            <Button
              variant="contained"
              startIcon={<SmartToy />}
              onClick={handleAsk}
              disabled={!prompt.trim() || loadingAsk}
              fullWidth
            >
              {loadingAsk ? 'Wysyłanie do LLM...' : 'Wyślij do LLM'}
            </Button>

            {loadingAsk && <LinearProgress sx={{ mt: 2 }} />}
          </Paper>
        </Grid>

        <Grid item xs={12} md={5}>
          <Paper sx={{ p: 2, backgroundColor: 'background.paper', height: '100%', overflowY: 'auto' }}>
            <Typography variant="h6" gutterBottom>
              Plan i wynik
            </Typography>
            {!result && (
              <Typography color="text.secondary">
                Wyślij zapytanie, aby zobaczyć proponowany plan działań.
              </Typography>
            )}
            {result && (
              <Box>
                {result.plan && (
                  <Box mb={2}>
                    <Typography variant="subtitle1" gutterBottom>
                      Plan
                    </Typography>
                    <Paper variant="outlined" sx={{ p: 2, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                      {result.plan}
                    </Paper>
                  </Box>
                )}

                {result.tasks && result.tasks.length > 0 && (
                  <Box mb={2}>
                    <Typography variant="subtitle1" gutterBottom>
                      Zadania
                    </Typography>
                    <List dense>
                      {result.tasks.map((task, idx) => (
                        <ListItem key={idx} divider>
                          <ListItemIcon>
                            <TaskAlt />
                          </ListItemIcon>
                          <ListItemText
                            primary={task.name || task.description || 'Nienazwane zadanie'}
                            secondary={task.description && task.name ? task.description : ''}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </Box>
                )}

                {result.executionResults && result.executionResults.length > 0 && (
                  <Box>
                    <Typography variant="subtitle1" gutterBottom>
                      Wyniki wykonania
                    </Typography>
                    {result.executionResults.map((execResult, idx) => (
                      <Accordion key={idx}>
                        <AccordionSummary expandIcon={<ExpandMore />}>
                          <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                            {execResult.status === 'success' ? (
                              <CheckCircle color="success" sx={{ mr: 1 }} />
                            ) : (
                              <ErrorIcon color="error" sx={{ mr: 1 }} />
                            )}
                            <Typography>
                              Krok {idx + 1}: {execResult.description}
                            </Typography>
                            <Chip
                              label={execResult.status}
                              color={execResult.status === 'success' ? 'success' : 'error'}
                              size="small"
                              sx={{ ml: 'auto' }}
                            />
                          </Box>
                        </AccordionSummary>
                        <AccordionDetails>
                          <Typography
                            component="pre"
                            sx={{
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-all',
                              fontFamily: 'monospace',
                              fontSize: '0.8rem',
                              backgroundColor: 'rgba(0,0,0,0.1)',
                              p: 1,
                              borderRadius: 1,
                            }}
                          >
                            {execResult.status === 'success'
                              ? execResult.result?.stdout || 'Brak standardowego wyjścia.'
                              : execResult.error || 'Wystąpił nieznany błąd.'}
                          </Typography>
                        </AccordionDetails>
                      </Accordion>
                    ))}
                  </Box>
                )}
              </Box>
            )}
          </Paper>
        </Grid>
      </Grid>

      <Paper sx={{ p: 2, mt: 3, backgroundColor: 'background.paper' }}>
        <Box display="flex" alignItems="center" mb={1}>
          <History sx={{ mr: 1 }} />
          <Typography variant="h6">Ostatnie zapytania</Typography>
        </Box>
        {loadingHistory && <LinearProgress sx={{ mb: 1 }} />}
        {!loadingHistory && history.length === 0 && (
          <Typography color="text.secondary">
            Brak historii zapytań.
          </Typography>
        )}
        <Box display="flex" flexWrap="wrap" gap={1}>
          {history.map((item) => (
            <Card
              key={item.id || item.timestamp}
              sx={{ minWidth: 260, maxWidth: 320 }}
            >
              <CardContent>
                <Typography
                  variant="subtitle2"
                  noWrap
                  gutterBottom
                >
                  {item.prompt || item.summary || 'Zapytanie'}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  display="block"
                >
                  {item.serverId
                    ? `Serwer: ${servers.find(s => s.id === item.serverId)?.name || item.serverId}`
                    : 'Globalne'}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  display="block"
                >
                  {item.autoExecute ? 'auto-execute' : ''}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  display="block"
                >
                  {item.createdAt &&
                    new Date(item.createdAt).toLocaleString()}
                </Typography>
                <Box mt={1} display="flex" gap={1}>
                  <IconButton
                    size="small"
                    onClick={() => {
                      if (item.prompt) {
                        setPrompt(item.prompt);
                        if (item.serverId) {
                          setTargetServerId(item.serverId);
                          setSelectedServerId(item.serverId);
                        }
                      }
                    }}
                  >
                    <Send fontSize="small" />
                  </IconButton>
                </Box>
              </CardContent>
            </Card>
          ))}
        </Box>
      </Paper>
    </Box>
  );
}

export default LLMPrompt;