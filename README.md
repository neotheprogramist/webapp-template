# Qwik City App ⚡️

- [Qwik Docs](https://qwik.builder.io/)
- [Discord](https://qwik.builder.io/chat)
- [Qwik GitHub](https://github.com/BuilderIO/qwik)
- [@QwikDev](https://twitter.com/QwikDev)
- [Vite](https://vitejs.dev/)

---

## Project Structure

This project is using Qwik with [QwikCity](https://qwik.builder.io/qwikcity/overview/). QwikCity is just an extra set of tools on top of Qwik to make it easier to build a full site, including directory-based routing, layouts, and more.

Inside your project, you'll see the following directory structure:

```
├── public/
│   └── ...
└── src/
    ├── components/
    │   └── ...
    └── routes/
        └── ...
```

- `src/routes`: Provides the directory-based routing, which can include a hierarchy of `layout.tsx` layout files, and an `index.tsx` file as the page. Additionally, `index.ts` files are endpoints. Please see the [routing docs](https://qwik.builder.io/qwikcity/routing/overview/) for more info.

- `src/components`: Recommended directory for components.

- `public`: Any static assets, like images, can be placed in the public directory. Please see the [Vite public directory](https://vitejs.dev/guide/assets.html#the-public-directory) for more info.

## Add Integrations and deployment

Use the `npm run qwik add` command to add additional integrations. Some examples of integrations includes: Cloudflare, Netlify or Express Server, and the [Static Site Generator (SSG)](https://qwik.builder.io/qwikcity/guides/static-site-generation/).

```shell
npm run qwik add # or `yarn qwik add`
```

## Development

Development mode uses [Vite's development server](https://vitejs.dev/). The `dev` command will server-side render (SSR) the output during development.

```shell
npm start # or `yarn start`
```

> Note: during dev mode, Vite may request a significant number of `.js` files. This does not represent a Qwik production build.

## Preview

The preview command will create a production build of the client modules, a production build of `src/entry.preview.tsx`, and run a local server. The preview server is only for convenience to preview a production build locally and should not be used as a production server.

```shell
npm run preview # or `yarn preview`
```

## Production

The production build will generate client and server modules by running both client and server build commands. The build command will use Typescript to run a type check on the source code.

```shell
npm run build # or `yarn build`
```

## Fastify Server

This app has a minimal [Fastify server](https://fastify.dev/) implementation. After running a full build, you can preview the build using the command:

```
npm run serve
```

Then visit [http://localhost:3000/](http://localhost:3000/)

## Kind Cluster Setup

This section guides you through the process of setting up a Kind Cluster. Follow the steps below:

1. **Create a Python virtual environment:**

   ```bash
   python -m venv .venv
   ```

2. **Activate the virtual environment:**

   ```bash
   source .venv/bin/activate
   ```

3. **Upgrade pip, the Python package installer:**

   ```bash
   pip install --upgrade pip
   ```

4. **Install the required Python packages:**

   These are listed in the `kind/requirements.txt` file.

   ```bash
   pip install -r kind/requirements.txt
   ```

5. **Install the required Ansible collections:**

   These are listed in the `kind/ansible-requirements.yaml` file.

   ```bash
   ansible-galaxy collection install -r kind/ansible-requirements.yaml
   ```

6. **Create a new Kind cluster:**

   This uses the configuration specified in the `kind/kind.yaml` file.

   ```bash
   kind create cluster --config kind/kind.yaml
   ```

7. **Configure your environment variables:**

   Create and edit the `.env` and `.env.local` files in the `k8s/patches/dev` directory as needed.

   ```bash
   vim k8s/patches/dev/.env
   vim k8s/patches/dev/.env.local
   ```

8. **Run the Ansible playbook:**

   This playbook sets up the Kind cluster as specified in the `kind/install.yaml` file.

   ```bash
   ansible-playbook kind/install.yaml
   ```

9. **Apply the Kubernetes patches:**

   This applies the patches in the `k8s/patches/dev` directory to your Kubernetes cluster.

   ```bash
    kubectl apply -k k8s/patches/dev
   ```
