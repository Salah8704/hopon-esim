'use strict';

(()=>{
  const initialParams=new URLSearchParams(location.search);
  const checkoutSession=initialParams.get('session_id');
  if(/^cs_(test|live)_[A-Za-z0-9]+$/.test(String(checkoutSession||''))){
    window.HOPON_CHECKOUT_SESSION_ID=checkoutSession;
    initialParams.delete('session_id');
    const cleanQuery=initialParams.toString();
    history.replaceState({},'',`${location.pathname}${cleanQuery?`?${cleanQuery}`:''}${location.hash}`);
  }
  const language=['fr','en','de','it','es'].includes(document.documentElement.lang)?document.documentElement.lang:'fr';
  const copy={
    fr:{title:'Vos choix de confidentialité',body:'Avec votre accord, HopOn utilise Google Analytics pour comprendre la fréquentation et améliorer le parcours d’achat. Vous pouvez accepter, refuser ou modifier votre choix à tout moment.',accept:'Tout accepter',reject:'Tout refuser',customize:'Personnaliser',analytics:'Mesure d’audience Google Analytics',save:'Enregistrer mon choix',manage:'Gérer mes cookies',privacy:'Politique de confidentialité'},
    en:{title:'Your privacy choices',body:'With your permission, HopOn uses Google Analytics to understand traffic and improve the purchasing journey. You can accept, refuse or change your choice at any time.',accept:'Accept all',reject:'Reject all',customize:'Customise',analytics:'Google Analytics audience measurement',save:'Save my choice',manage:'Manage cookies',privacy:'Privacy policy'},
    de:{title:'Ihre Datenschutzeinstellungen',body:'Mit Ihrer Einwilligung nutzt HopOn Google Analytics, um Besuche zu verstehen und den Kaufprozess zu verbessern. Sie können Ihre Auswahl jederzeit annehmen, ablehnen oder ändern.',accept:'Alle akzeptieren',reject:'Alle ablehnen',customize:'Anpassen',analytics:'Reichweitenmessung mit Google Analytics',save:'Auswahl speichern',manage:'Cookies verwalten',privacy:'Datenschutzerklärung'},
    it:{title:'Le tue scelte sulla privacy',body:'Con il tuo consenso, HopOn usa Google Analytics per comprendere le visite e migliorare il percorso di acquisto. Puoi accettare, rifiutare o modificare la scelta in qualsiasi momento.',accept:'Accetta tutto',reject:'Rifiuta tutto',customize:'Personalizza',analytics:'Misurazione con Google Analytics',save:'Salva la scelta',manage:'Gestisci cookie',privacy:'Informativa sulla privacy'},
    es:{title:'Tus opciones de privacidad',body:'Con tu permiso, HopOn utiliza Google Analytics para comprender las visitas y mejorar el proceso de compra. Puedes aceptar, rechazar o cambiar tu elección en cualquier momento.',accept:'Aceptar todo',reject:'Rechazar todo',customize:'Personalizar',analytics:'Medición con Google Analytics',save:'Guardar mi elección',manage:'Gestionar cookies',privacy:'Política de privacidad'}
  }[language];
  const privacyPaths={fr:'/confidentialite.html',en:'/en/privacy.html',de:'/de/datenschutz.html',it:'/it/privacy.html',es:'/es/privacidad.html'};
  const config=window.HOPON_ANALYTICS||{};
  const containerId=/^GTM-[A-Z0-9]+$/i.test(String(config.containerId||''))?String(config.containerId).toUpperCase():'';
  const measurementId=/^G-[A-Z0-9]+$/i.test(String(config.measurementId||''))?String(config.measurementId).toUpperCase():'';
  const storageKey='hopon-analytics-consent-v1';
  const maxAge=183*24*60*60*1000;
  let choice=null;
  let loaded=false;
  const pending=[];

  function readChoice(){
    try{const value=JSON.parse(localStorage.getItem(storageKey)||'null');if(value&&['granted','denied'].includes(value.analytics)&&Date.now()-Number(value.savedAt||0)<maxAge)return value;}catch(_){}
    return null;
  }
  function persist(analytics){choice={analytics,savedAt:Date.now()};try{localStorage.setItem(storageKey,JSON.stringify(choice));}catch(_){}applyChoice();closePanel();}
  function consentCommand(state){window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){window.dataLayer.push(arguments);};window.gtag('consent',state==='default'?'default':'update',{analytics_storage:state==='granted'?'granted':'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});}
  function loadAnalytics(){
    if(loaded||!containerId)return;loaded=true;window.dataLayer=window.dataLayer||[];
    window.dataLayer.push({'gtm.start':Date.now(),event:'gtm.js',hopon_measurement_id:measurementId});
    const script=document.createElement('script');script.async=true;script.src=`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;document.head.appendChild(script);
    while(pending.length){const [name,parameters]=pending.shift();window.dataLayer.push({event:name,...parameters});}
  }
  function applyChoice(){if(!containerId)return;consentCommand(choice?.analytics==='granted'?'granted':'denied');if(choice?.analytics==='granted')loadAnalytics();else pending.length=0;}
  function event(name,parameters={}){if(!containerId||choice?.analytics!=='granted')return;const safe={...parameters};delete safe.email;delete safe.name;delete safe.phone;delete safe.session_id;if(loaded)window.dataLayer.push({event:name,...safe});else pending.push([name,safe]);}
  window.hoponAnalyticsEvent=event;

  function closePanel(){document.querySelector('#hopon-consent')?.remove();}
  function showPanel(custom=false){
    if(!containerId)return;closePanel();const host=document.createElement('section');host.id='hopon-consent';host.className='consent-panel';host.setAttribute('role','dialog');host.setAttribute('aria-modal','true');host.setAttribute('aria-labelledby','consent-title');
    host.innerHTML=`<div class="consent-card"><h2 id="consent-title">${copy.title}</h2><p>${copy.body} <a href="${privacyPaths[language]}">${copy.privacy}</a>.</p>${custom?`<label class="consent-toggle"><input id="consent-analytics" type="checkbox" ${choice?.analytics==='granted'?'checked':''}><span>${copy.analytics}</span></label><div class="consent-actions"><button type="button" data-consent-save>${copy.save}</button><button type="button" data-consent-reject>${copy.reject}</button></div>`:`<div class="consent-actions"><button type="button" data-consent-accept>${copy.accept}</button><button type="button" data-consent-reject>${copy.reject}</button><button type="button" data-consent-customize>${copy.customize}</button></div>`}</div>`;
    document.body.appendChild(host);host.querySelector('[data-consent-accept]')?.addEventListener('click',()=>persist('granted'));host.querySelector('[data-consent-reject]')?.addEventListener('click',()=>persist('denied'));host.querySelector('[data-consent-customize]')?.addEventListener('click',()=>showPanel(true));host.querySelector('[data-consent-save]')?.addEventListener('click',()=>persist(host.querySelector('#consent-analytics').checked?'granted':'denied'));host.querySelector('button')?.focus();
  }
  function addManageLink(){if(!containerId)return;const nav=document.querySelector('footer nav');if(!nav||document.querySelector('[data-consent-manage]'))return;const button=document.createElement('button');button.type='button';button.className='footer-link-button';button.dataset.consentManage='';button.textContent=copy.manage;button.addEventListener('click',()=>showPanel(true));nav.appendChild(button);}

  if(!containerId)return;
  consentCommand('default');choice=readChoice();applyChoice();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{addManageLink();if(!choice)showPanel();});else{addManageLink();if(!choice)showPanel();}
})();
