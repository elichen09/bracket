//! Partners, straight from one app to the other (iroh).
//!
//! The page's rooms — Flow's shared round, the speech doc's Room — are named
//! by a code the two of you read out. This is a second road for them, beside
//! the relay the page already uses: one coda app connects to the other coda
//! app directly, over the same Wi-Fi even when it has no internet, or across
//! the internet with iroh punching through (or relaying, end-to-end encrypted,
//! when it can't).
//!
//! How two apps find each other:
//! - **Same network.** Each app announces itself over mDNS (only to other coda
//!   apps) with a short tag for each room it's in — a hash of the room's name,
//!   never the code itself. An app that sees one of its own tags connects.
//! - **Anywhere.** The page tells this module a partner's address when the
//!   relay's presence brings one (`dial`), and it connects to that.
//!
//! Of any two apps, the one whose id sorts first does the dialling, so a pair
//! only ever makes one connection, which carries every room they share. On it
//! each side says which rooms it's in, then messages flow as length-prefixed
//! JSON frames. Nothing is stored; nothing goes to a server but iroh's relay
//! (which can't read it) when there's no direct path.
//!
//! The page sees two kinds of event: a message in a room, and a partner coming
//! into or leaving a room it shares with them.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use iroh::{
    endpoint::{presets, Connection, RecvStream, SendStream},
    endpoint_info::UserData,
    Endpoint, EndpointAddr, EndpointId, RelayMode,
};
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

pub const ALPN: &[u8] = b"coda/room/1";
/// A whole flow or a whole speech doc can be one message.
const MAX_FRAME: usize = 32 << 20;
/// Room tags fit mDNS's 245-byte user data with room to spare.
const MAX_ROOMS_ANNOUNCED: usize = 16;

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event {
    /// A message in a room, from the partner app `from`.
    Msg { room: String, from: String, data: String },
    /// A partner app came into (`up`) or left a room you're both in.
    Peer { room: String, peer: String, up: bool },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "t")]
enum Frame {
    /// The rooms this side is in, by tag; sent first, and again on every change.
    Rooms { rooms: Vec<String> },
    Msg { room: String, data: String },
}

/// A room's tag: a hash of its name, so the code itself is never announced.
pub fn room_tag(name: &str) -> String {
    let h = Sha256::digest(format!("coda-room:{name}").as_bytes());
    hex::encode(&h[..6])
}

fn first(a: &EndpointId, b: &EndpointId) -> bool {
    a.as_bytes() < b.as_bytes()
}

struct Peer {
    serial: u64,
    tx: mpsc::UnboundedSender<Vec<u8>>,
    conn: Connection,
    /// heard their rooms yet
    heard: bool,
    rooms: HashSet<String>,
    /// rooms we share, as last told to the page
    shared: HashSet<String>,
}

#[derive(Default)]
struct Candidate {
    addr: Option<EndpointAddr>,
    /// their rooms, as announced on the network
    lan: HashSet<String>,
    /// rooms the page saw them in on the relay
    told: HashSet<String>,
    next_try: Option<Instant>,
    fails: u32,
    dialing: bool,
}

#[derive(Default)]
struct State {
    /// tag → name
    rooms: HashMap<String, String>,
    peers: HashMap<EndpointId, Peer>,
    cands: HashMap<EndpointId, Candidate>,
    serial: u64,
}

pub struct Mesh {
    ep: Endpoint,
    _mdns: Option<MdnsAddressLookup>,
    st: Mutex<State>,
    emit: Box<dyn Fn(Event) + Send + Sync>,
}

fn frame(f: &Frame) -> Vec<u8> {
    let body = serde_json::to_vec(f).unwrap_or_default();
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(body);
    out
}

impl Mesh {
    /// The endpoint, listening, announced on the network. Must run inside a tokio runtime.
    pub async fn start(emit: impl Fn(Event) + Send + Sync + 'static) -> Result<Arc<Mesh>, String> {
        let ep = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Default)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| format!("couldn't open the connection: {e}"))?;
        // Only coda apps hear this; a network that forbids multicast still leaves the internet road.
        // (CODA_P2P_NO_MDNS turns it off, to test the internet road on one machine.)
        let mdns = if std::env::var_os("CODA_P2P_NO_MDNS").is_some() { None } else { MdnsAddressLookup::builder().service_name("coda").build(ep.id()).ok() };
        if let (Some(m), Ok(lookup)) = (&mdns, ep.address_lookup()) {
            lookup.add(m.clone());
        }
        let mesh = Arc::new(Mesh { ep, _mdns: mdns.clone(), st: Mutex::new(State::default()), emit: Box::new(emit) });

        // partners connecting to us
        let w = Arc::downgrade(&mesh);
        let ep = mesh.ep.clone();
        tokio::spawn(async move {
            while let Some(inc) = ep.accept().await {
                let w = w.clone();
                tokio::spawn(async move {
                    let Ok(conn) = inc.await else { return };
                    let Ok(Ok((send, recv))) = tokio::time::timeout(Duration::from_secs(20), conn.accept_bi()).await else { return };
                    if let Some(m) = w.upgrade() {
                        m.attach(conn, send, recv, false);
                    }
                });
            }
        });

        // coda apps on this network, and the rooms they're in
        if let Some(m) = mdns {
            let w = Arc::downgrade(&mesh);
            tokio::spawn(async move {
                let mut events = m.subscribe().await;
                while let Some(ev) = events.next().await {
                    let Some(mesh) = w.upgrade() else { break };
                    match ev {
                        DiscoveryEvent::Discovered { endpoint_info, .. } => {
                            if endpoint_info.endpoint_id == mesh.ep.id() { continue; }
                            let tags: HashSet<String> = endpoint_info
                                .data
                                .user_data()
                                .map(|u| u.to_string().split(',').filter(|s| !s.is_empty()).map(String::from).collect())
                                .unwrap_or_default();
                            let mut st = mesh.st.lock().unwrap();
                            let c = st.cands.entry(endpoint_info.endpoint_id).or_default();
                            if c.lan != tags { c.next_try = None; c.fails = 0; }
                            c.lan = tags;
                        }
                        DiscoveryEvent::Expired { endpoint_id } => {
                            let mut st = mesh.st.lock().unwrap();
                            if let Some(c) = st.cands.get_mut(&endpoint_id) { c.lan.clear(); }
                        }
                        _ => {}
                    }
                }
            });
        }

        // the dialling: whoever sorts first connects, and reconnects after a drop
        let w = Arc::downgrade(&mesh);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            loop {
                tick.tick().await;
                let Some(mesh) = w.upgrade() else { break };
                mesh.dial_due(&Arc::downgrade(&mesh));
            }
        });

        Ok(mesh)
    }

    pub fn id(&self) -> String {
        self.ep.id().to_string()
    }

    /// Where a partner can reach this app, for the page to put in its presence.
    /// Waits briefly for the relay so the address works from anywhere; offline, the local one.
    pub async fn addr(&self) -> String {
        let _ = tokio::time::timeout(Duration::from_secs(3), self.ep.online()).await;
        serde_json::to_string(&self.ep.addr()).unwrap_or_default()
    }

    pub fn join(&self, room: &str) {
        let mut evs = vec![];
        {
            let mut st = self.st.lock().unwrap();
            st.rooms.insert(room_tag(room), room.to_string());
            self.rooms_changed(&mut st, &mut evs);
        }
        self.fire(evs);
    }

    pub fn leave(&self, room: &str) {
        let mut evs = vec![];
        {
            let mut st = self.st.lock().unwrap();
            let tag = room_tag(room);
            st.rooms.remove(&tag);
            for c in st.cands.values_mut() { c.told.remove(&tag); }
            self.rooms_changed(&mut st, &mut evs);
        }
        // the page is leaving; it doesn't need to hear its partners go
        let tag = room_tag(room);
        evs.retain(|e| !matches!(e, Event::Peer { room: r, .. } if r == room || *r == tag));
        self.fire(evs);
    }

    /// To every partner app in the room.
    pub fn send(&self, room: &str, data: String) {
        let tag = room_tag(room);
        let st = self.st.lock().unwrap();
        if !st.rooms.contains_key(&tag) { return; }
        let buf = frame(&Frame::Msg { room: tag.clone(), data });
        for p in st.peers.values() {
            if p.rooms.contains(&tag) { let _ = p.tx.send(buf.clone()); }
        }
    }

    /// A partner the page met on the relay: connect to them directly, too.
    pub fn dial(&self, addr: &str, room: &str) -> Result<(), String> {
        let addr: EndpointAddr = serde_json::from_str(addr).map_err(|e| e.to_string())?;
        if addr.id == self.ep.id() { return Ok(()); }
        let mut st = self.st.lock().unwrap();
        let c = st.cands.entry(addr.id).or_default();
        if c.addr.as_ref() != Some(&addr) { c.next_try = None; c.fails = 0; }
        c.addr = Some(addr);
        c.told.insert(room_tag(room));
        Ok(())
    }


    /* ------------------------------------------------------------------ */

    fn fire(&self, evs: Vec<Event>) {
        for e in evs { (self.emit)(e); }
    }

    /// After our rooms change: tell the network and every partner, and settle who shares what.
    fn rooms_changed(&self, st: &mut State, evs: &mut Vec<Event>) {
        let tags: Vec<String> = st.rooms.keys().cloned().collect();
        let ud = tags.iter().take(MAX_ROOMS_ANNOUNCED).cloned().collect::<Vec<_>>().join(",");
        self.ep.set_user_data_for_address_lookup(if ud.is_empty() { None } else { ud.parse::<UserData>().ok() });
        let buf = frame(&Frame::Rooms { rooms: tags });
        for p in st.peers.values() { let _ = p.tx.send(buf.clone()); }
        let ids: Vec<EndpointId> = st.peers.keys().cloned().collect();
        for id in ids { self.settle(st, id, evs); }
    }

    /// The rooms this partner and we share now, against what the page was told; a
    /// partner we share nothing with any more is let go.
    fn settle(&self, st: &mut State, id: EndpointId, evs: &mut Vec<Event>) {
        let mine: HashSet<String> = st.rooms.keys().cloned().collect();
        let Some(p) = st.peers.get_mut(&id) else { return };
        if !p.heard { return; }
        let now: HashSet<String> = p.rooms.intersection(&mine).cloned().collect();
        for t in now.difference(&p.shared) {
            if let Some(name) = st.rooms.get(t) { evs.push(Event::Peer { room: name.clone(), peer: id.to_string(), up: true }); }
        }
        for t in p.shared.difference(&now) {
            // a room we just left has no name any more; the page has gone from it anyway
            evs.push(Event::Peer { room: t.clone(), peer: id.to_string(), up: false });
        }
        p.shared = now;
        if p.shared.is_empty() {
            p.conn.close(0u32.into(), b"nothing shared");
            st.peers.remove(&id);
        }
        // name the rooms we left for the page (the tag stands in otherwise)
        for e in evs.iter_mut() {
            if let Event::Peer { room, .. } = e {
                if let Some(name) = st.rooms.get(room.as_str()) { *room = name.clone(); }
            }
        }
    }

    fn dial_due(&self, w: &Weak<Mesh>) {
        let me = self.ep.id();
        let now = Instant::now();
        let mut st = self.st.lock().unwrap();
        let mine: HashSet<String> = st.rooms.keys().cloned().collect();
        if mine.is_empty() { return; }
        let connected: HashSet<EndpointId> = st.peers.keys().cloned().collect();
        let mut go = vec![];
        for (id, c) in st.cands.iter_mut() {
            if c.dialing || connected.contains(id) || !first(&me, id) { continue; }
            if c.lan.is_disjoint(&mine) && c.told.is_disjoint(&mine) { continue; }
            if c.next_try.is_some_and(|t| t > now) { continue; }
            c.dialing = true;
            go.push((*id, c.addr.clone().filter(|_| c.lan.is_disjoint(&mine)).unwrap_or_else(|| (*id).into()), c.addr.clone()));
        }
        drop(st);
        for (id, target, told_addr) in go {
            let w = w.clone();
            tokio::spawn(async move {
                let Some(m) = w.upgrade() else { return };
                let ep = m.ep.clone();
                drop(m);
                // on the network by id (mDNS finds it); else by the address the page passed on
                let mut res = tokio::time::timeout(Duration::from_secs(12), ep.connect(target, ALPN)).await;
                if !matches!(res, Ok(Ok(_))) {
                    if let Some(a) = told_addr {
                        res = tokio::time::timeout(Duration::from_secs(12), ep.connect(a, ALPN)).await;
                    }
                }
                let Some(m) = w.upgrade() else { return };
                let opened = match res {
                    Ok(Ok(conn)) => match conn.open_bi().await {
                        Ok((send, recv)) => Some((conn, send, recv)),
                        Err(_) => None,
                    },
                    _ => None,
                };
                {
                    let mut st = m.st.lock().unwrap();
                    if let Some(c) = st.cands.get_mut(&id) {
                        c.dialing = false;
                        if opened.is_some() {
                            c.fails = 0;
                            c.next_try = None;
                        } else {
                            c.fails += 1;
                            c.next_try = Some(Instant::now() + Duration::from_secs((1u64 << c.fails.min(5)).min(30)));
                            // someone the relay told us of, gone quiet: stop trying
                            if c.fails >= 8 && c.lan.is_empty() { st.cands.remove(&id); }
                        }
                    }
                }
                if let Some((conn, send, recv)) = opened {
                    m.attach(conn, send, recv, true);
                }
            });
        }
    }

    /// A connection up, either way: keep it (the one the first-sorting side dialled, if
    /// there are two), say our rooms, and read and write on it until it closes.
    fn attach(self: &Arc<Self>, conn: Connection, mut send: SendStream, mut recv: RecvStream, outgoing: bool) {
        let me = self.ep.id();
        let pid = conn.remote_id();
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let serial;
        {
            let mut st = self.st.lock().unwrap();
            let mut shared = HashSet::new();
            if let Some(old) = st.peers.get(&pid) {
                let by_first = if outgoing { first(&me, &pid) } else { first(&pid, &me) };
                if !by_first {
                    conn.close(0u32.into(), b"duplicate");
                    return;
                }
                old.conn.close(0u32.into(), b"duplicate");
                shared = old.shared.clone();
            }
            st.serial += 1;
            serial = st.serial;
            let _ = tx.send(frame(&Frame::Rooms { rooms: st.rooms.keys().cloned().collect() }));
            st.peers.insert(pid, Peer { serial, tx, conn: conn.clone(), heard: false, rooms: HashSet::new(), shared });
        }

        tokio::spawn(async move {
            while let Some(buf) = rx.recv().await {
                if send.write_all(&buf).await.is_err() { break; }
            }
            let _ = send.finish();
        });

        let w = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let mut len = [0u8; 4];
                if recv.read_exact(&mut len).await.is_err() { break; }
                let n = u32::from_be_bytes(len) as usize;
                if n > MAX_FRAME { break; }
                let mut body = vec![0u8; n];
                if recv.read_exact(&mut body).await.is_err() { break; }
                let Some(m) = w.upgrade() else { return };
                let Ok(f) = serde_json::from_slice::<Frame>(&body) else { continue };
                let mut evs = vec![];
                {
                    let mut st = m.st.lock().unwrap();
                    if st.peers.get(&pid).map(|p| p.serial) != Some(serial) { break; }
                    match f {
                        Frame::Rooms { rooms } => {
                            if let Some(p) = st.peers.get_mut(&pid) {
                                p.heard = true;
                                p.rooms = rooms.into_iter().collect();
                            }
                            m.settle(&mut st, pid, &mut evs);
                        }
                        Frame::Msg { room, data } => {
                            if let Some(name) = st.rooms.get(&room) {
                                evs.push(Event::Msg { room: name.clone(), from: pid.to_string(), data });
                            }
                        }
                    }
                }
                m.fire(evs);
            }
            // gone: the page hears they've left each room we shared, and the dialler tries again soon
            let Some(m) = w.upgrade() else { return };
            let mut evs = vec![];
            {
                let mut st = m.st.lock().unwrap();
                if st.peers.get(&pid).map(|p| p.serial) == Some(serial) {
                    let p = st.peers.remove(&pid).unwrap();
                    p.conn.close(0u32.into(), b"bye");
                    for t in p.shared {
                        if let Some(name) = st.rooms.get(&t) {
                            evs.push(Event::Peer { room: name.clone(), peer: pid.to_string(), up: false });
                        }
                    }
                    if let Some(c) = st.cands.get_mut(&pid) { c.next_try = Some(Instant::now() + Duration::from_secs(1)); }
                }
            }
            m.fire(evs);
        });
    }
}
