import { Suspense } from "react";
import Nav from "@/components/Nav";
import AuthForm from "@/components/AuthForm";
import Strata from "@/components/Strata";

export const metadata = { title: "Sign in · The Break" };

export default function LoginPage() {
  return (
    <>
      <Nav />
      <main>
        <section className="view enter auth-view">
          <div className="auth-art" aria-hidden="true">
            <Strata palette="reef" />
            <div className="grain" />
          </div>
          <div className="auth-side">
            <div className="auth-copy">
              <p className="crumb mono reveal">Members only</p>
              <h1 className="reveal">One bracket.<br /><em>Per person.</em></h1>
              <p className="prose reveal">
                An account ties your picks to you: one bracket per tournament, scored on the same
                leaderboard as everyone else, and a dossier on every team the moment you click it.
              </p>
            </div>
            <Suspense fallback={null}>
              <AuthForm />
            </Suspense>
          </div>
        </section>
      </main>
    </>
  );
}
