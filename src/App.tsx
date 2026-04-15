import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";
import { supabase } from "./lib/supabase";

type Touch = {
  id: string;
  lat: number;
  lng: number;
  created_at: string;
};

function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  const [touches, setTouches] = useState<Touch[]>([]);
  const [loading, setLoading] = useState(false);
  const [countToday, setCountToday] = useState(0);
  const [errorText, setErrorText] = useState("");
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    mapRef.current = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://demotiles.maplibre.org/style.json",
      center: [0, 20],
      zoom: 2,
    });

    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-right");

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  const loadTouches = async () => {
    const { data, error } = await supabase
      .from("touches")
      .select("id, lat, lng, created_at")
      .order("created_at", { ascending: false })
      .limit(1000);

    if (error) {
      setErrorText("Ошибка загрузки точек");
      return;
    }

    setTouches((data || []) as Touch[]);
  };

  const loadCountToday = async () => {
    const utcStart = new Date();
    utcStart.setUTCHours(0, 0, 0, 0);

    const { count, error } = await supabase
      .from("touches")
      .select("*", { count: "exact", head: true })
      .gte("created_at", utcStart.toISOString());

    if (!error && typeof count === "number") {
      setCountToday(count);
    }
  };

  useEffect(() => {
    loadTouches();
    loadCountToday();

    const channel = supabase
      .channel("touches-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "touches" },
        (payload) => {
          const t = payload.new as Touch;
          setTouches((prev) => [t, ...prev].slice(0, 1000));
          setCountToday((prev) => prev + 1);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    touches.forEach((touch) => {
      const el = document.createElement("div");
      el.className = "touch-dot";

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([touch.lng, touch.lat])
        .addTo(mapRef.current!);

      markersRef.current.push(marker);
    });
  }, [touches]);

  const handleGoogleSignIn = async () => {
    setErrorText("");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (error) setErrorText("Ошибка входа через Google");
  };

  const handleSignOut = async () => {
    setErrorText("");
    const { error } = await supabase.auth.signOut();
    if (error) setErrorText("Ошибка выхода");
  };

  const handleTouchGrass = async () => {
    setErrorText("");

    if (!navigator.geolocation) {
      setErrorText("Геолокация не поддерживается браузером");
      return;
    }

    setLoading(true);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const lat = Number(position.coords.latitude.toFixed(2));
          const lng = Number(position.coords.longitude.toFixed(2));

          const deviceIdKey = "touch_grass_device_id";
          let deviceId = localStorage.getItem(deviceIdKey);

          if (!deviceId) {
            deviceId = crypto.randomUUID();
            localStorage.setItem(deviceIdKey, deviceId);
          }

          const { error } = await supabase.rpc("touch_grass", {
            p_lat: lat,
            p_lng: lng,
            p_device_id: deviceId,
            p_is_private: false,
            p_source: "web",
            p_client_ts: new Date().toISOString(),
          });

          if (error) {
            const msg = (error.message || "").toLowerCase();
            if (msg.includes("too_many_requests")) {
              setErrorText("Слишком часто. Попробуй снова через 5 минут.");
            } else {
              setErrorText("Не удалось сохранить touch");
            }
          } else {
            localStorage.setItem("lastTouch", new Date().toISOString());
            setErrorText("");

            if (mapRef.current) {
              mapRef.current.flyTo({
                center: [lng, lat],
                zoom: 11,
                duration: 1500,
                essential: true,
              });
            }
          }
        } catch {
          setErrorText("Ошибка при сохранении");
        } finally {
          setLoading(false);
        }
      },
      (geoError) => {
        setLoading(false);

        if (geoError.code === geoError.PERMISSION_DENIED) {
          setErrorText("Разреши геолокацию в настройках браузера");
        } else if (geoError.code === geoError.TIMEOUT) {
          setErrorText("Геолокация не ответила вовремя, попробуй снова");
        } else {
          setErrorText("Не удалось определить местоположение");
        }
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <div className="app">
      <div ref={mapContainerRef} className="map" />

      <div className="authBox">
        {session?.user ? (
          <>
            <span className="authText">{session.user.email}</span>
            <button className="authBtn" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        ) : (
          <button className="authBtn" onClick={handleGoogleSignIn}>
            Sign in with Google
          </button>
        )}
      </div>

      <div className="topRight">🌿 {countToday} touches today worldwide</div>

      {errorText ? <div className="errorBox">{errorText}</div> : null}

      <button className="touchBtn" onClick={handleTouchGrass} disabled={loading}>
        {loading ? "Finding you..." : "🌿 Touch Grass"}
      </button>
    </div>
  );
}

export default App;