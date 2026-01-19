import React, { useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material';
import { Lock } from '@mui/icons-material';

const api = window.api;

function Login({ onLoginSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!username.trim() || !password.trim()) {
      setError('Wprowadź nazwę użytkownika i hasło');
      return;
    }

    if (!api || !api.auth) {
      setError('API niedostępne');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const res = await api.auth.login(username, password);

      if (res && res.error) {
        setError(res.error.message || 'Błąd logowania');
        return;
      }

      if (res && res.sessionToken) {
        // Store session token in preload
        api.auth.setSessionToken(res.sessionToken);
        onLoginSuccess(res.user, res.sessionToken);
      } else {
        setError('Nieprawidłowa odpowiedź serwera');
      }
    } catch (err) {
      console.error('Login error:', err);
      setError(err.message || 'Błąd podczas logowania');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
      }}
    >
      <Card sx={{ maxWidth: 400, width: '100%', mx: 2 }}>
        <CardContent sx={{ p: 4 }}>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              mb: 3,
            }}
          >
            <Lock sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
            <Typography variant="h5" component="h1" gutterBottom>
              AI Admin Console
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Zaloguj się, aby kontynuować
            </Typography>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit}>
            <TextField
              label="Nazwa użytkownika"
              fullWidth
              margin="normal"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              autoFocus
              autoComplete="username"
            />
            <TextField
              label="Hasło"
              type="password"
              fullWidth
              margin="normal"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              autoComplete="current-password"
            />
            <Button
              type="submit"
              variant="contained"
              fullWidth
              size="large"
              sx={{ mt: 3 }}
              disabled={loading}
            >
              {loading ? (
                <CircularProgress size={24} color="inherit" />
              ) : (
                'Zaloguj się'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}

export default Login;
