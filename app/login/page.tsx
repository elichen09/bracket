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
              <p className="crumb mono reveal">Your account</p>
              <h1 className="reveal">Your files.<br /><em>Your keys.</em></h1>
              <p className="prose reveal">
                An account keeps your files, your library and your shortcuts apart from anyone else&apos;s on this
                computer — and it is how a partner you send a link to gets into the same doc as you.
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
