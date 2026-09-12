// Vaut le Coup ? — démarrage production simplifié.
// Toute la logique est désormais dans server.js : une seule instance,
// un seul port et aucun proxy/wrapper intermédiaire.
await import('./server.js');
