export async function getServerSideProps() {
  return {
    redirect: {
      destination: '/game',
      permanent: false,
    },
  };
}

export default function Index() {
  return null;
}
