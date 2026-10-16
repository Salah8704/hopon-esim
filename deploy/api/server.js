'use strict';

// Point d'entrée compatible avec le réglage Hostinger `server.js`.
// src/server.js appelle listen() immédiatement. Ce relais n'en appelle pas un
// second, ce qui permet aussi de conserver `src/server.js` comme ancien réglage
// de fichier d'entrée sans casser le déploiement.
require('./src/server');
